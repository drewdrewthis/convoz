import { installedMachine, sidOf } from "../lib/cli.ts";
import { Client, DEVICE_COOKIE, send } from "../lib/http.ts";
import {
  ANY,
  HOUR,
  MINUTE,
  allow,
  bearer,
  countOf,
  createAgents,
  dataFileBytes,
  lease,
  loginMachine,
  mintSession,
  plainDb,
  stepUp,
  stepped,
  whoamiApi,
  withStepUp,
} from "../lib/machines.ts";
import { apiServer, bootstrapOwner, must, signIn } from "../lib/owner.ts";
import { expect, scenario } from "../lib/scenario.ts";
import { SoftAuthenticator } from "../lib/soft-authenticator.ts";

// The contract these bindings rely on is the comment block at the top of machine-login.spec.ts.

const PLAIN = { CONVOZ_TEST_PLAINTEXT: "1" };

/** The error code of a JSON answer, or the start of its body when it is not JSON. */
function codeOf(res: { text: string }): string {
  try {
    return JSON.parse(res.text).error.code as string;
  } catch {
    return res.text.slice(0, 40);
  }
}

// ---- crew (contracts) ------------------------------------------------------------------------------

scenario("Handle rules", { tag: ["@api"] }, async ({ server }) => {
  // Given the agent "devtool" exists
  const srv = await server(apiServer());
  const owner = await bootstrapOwner(srv);
  await createAgents(owner, "devtool");
  const rows: [string, number][] = [
    ["devtool2", 201],
    ["DevTool", 409],
    ["admin", 400],
    ["brief", 400],
    ["9lives", 400],
    ["a", 400],
    ["dev_tool", 400],
  ];

  // When the owner creates an agent with the handle <handle>
  const got: [string, number][] = [];
  for (const [handle] of rows) {
    const res = await stepped(owner, "POST", "/api/crew/agents", { handle, display_name: `Agent ${handle}` }, "identity.create");
    got.push([handle, res.status]);
  }

  // Then the server answers <status>
  expect(got).toEqual(rows);
});

scenario("A display name that looks like another identity is refused", { tag: ["@api"] }, async ({ server }) => {
  // Given the agent "devtool" (display name "Devtool") exists
  const srv = await server(apiServer());
  const owner = await bootstrapOwner(srv);
  await createAgents(owner, "devtool");

  // When the owner creates an agent named "devtooI" (a capital i) with the handle "helper"
  const res = await stepped(owner, "POST", "/api/crew/agents", { handle: "helper", display_name: "devtooI" }, "identity.create");

  // Then the server answers 400 naming "display_name"
  expect(res.status).toBe(400);
  expect(res.json().error.field).toBe("display_name");
});

scenario("No request can delete an identity or change its kind", { tag: ["@api"] }, async ({ server, dataDir }) => {
  // Given the agent "devtool" exists, on the encryption-off test build
  const srv = await server(apiServer({ env: PLAIN }));
  const owner = await bootstrapOwner(srv);
  const { devtool } = await createAgents(owner, "devtool");

  // When a client tries every identity route to delete "devtool" or change it from agent to human
  const id = devtool!.id;
  const answers = [
    await owner.client.del(`/api/identities/${id}`),
    await owner.client.request("PATCH", `/api/identities/${id}`, { csrf: true, json: { kind: "human" } }),
    await owner.client.request("PUT", `/api/identities/${id}`, { csrf: true, json: { kind: "human" } }),
    await stepped(owner, "POST", "/api/crew/agents", { handle: "devtool", display_name: "Devtool", kind: "human" }, "identity.create"),
  ];

  // And the test tries the same writes on the data file of the encryption-off test build
  const db = plainDb(dataDir);
  try {
    // Then every attempt is refused
    expect(answers.map((a) => a.status >= 400 && a.status < 500)).toEqual([true, true, true, true]);
    expect(() => db.prepare("DELETE FROM identities WHERE id = ?").run(id)).toThrow(/never deleted/);
    expect(() => db.prepare("UPDATE identities SET kind = 'human' WHERE id = ?").run(id)).toThrow(/immutable/);
  } finally {
    db.close();
  }

  // And GET /api/identities still lists "devtool" as an agent
  const list = must(await owner.client.get("/api/identities"), "identities").json().identities as { handle: string; kind: string }[];
  expect(list.find((i) => i.handle === "devtool")?.kind).toBe("agent");
});

// ---- onboarding ------------------------------------------------------------------------------------

scenario("A passkey added by recovery cannot do destructive things for 24 hours", { tag: ["@api"] }, async ({ server, testApi }) => {
  const srv = await server(apiServer());
  const clock = testApi(srv);
  const owner = await bootstrapOwner(srv);
  const box = await loginMachine(srv, owner, "box-2");

  // Given the owner added a passkey through a recovery code 2 hours ago
  const limited = new Client(srv.target);
  must(await limited.post("/api/auth/recovery", { code: owner.codes[0]! }), "use recovery code");
  const fresh = new SoftAuthenticator(srv.host, srv.origin);
  const opt = must(await limited.post("/api/auth/passkey/register/options", {}), "register options").json();
  must(await limited.post("/api/auth/passkey/register/verify", { ceremony_id: opt.ceremony_id, credential: fresh.create(opt.options.publicKey) }), "register verify");
  const device = new Client(srv.target);
  await signIn(device, fresh);
  const young = { client: device, soft: fresh };
  await clock.advanceClock(2 * HOUR);

  // When the owner tries to reveal a machine key with that passkey
  const options = must(await device.post("/api/auth/step-up/options", { action: "machine.reveal", target_id: box.id }), "step-up options").json();
  const verify = await device.post("/api/auth/step-up/verify", { ceremony_id: options.ceremony_id, credential: fresh.get(options.options.publicKey) });

  // Then the app refuses and says the passkey is too new for this action
  expect(verify.status).toBe(403);
  expect(verify.json().error.code).toBe("passkey_too_new");
  expect(verify.json().error.message).toMatch(/too new/i);

  // And the same action works with that passkey after the test clock passes 24 hours
  await clock.advanceClock(22 * HOUR + MINUTE);
  const reveal = await young.client.post(`/api/machines/${box.id}/reveal`, {}, withStepUp(await stepUp(young, "machine.reveal", box.id)));
  expect(reveal.status).toBe(200);
});

// ---- security: revoke and disable ------------------------------------------------------------------

scenario("Revoking one machine leaves the others working", { tag: ["@api"] }, async ({ server }) => {
  // Given machines "box-2" and "laptop-1" with a "devtool" session each
  const srv = await server(apiServer());
  const owner = await bootstrapOwner(srv);
  await createAgents(owner, "devtool");
  const box2 = await loginMachine(srv, owner, "box-2", allow("devtool"));
  const laptop = await loginMachine(srv, owner, "laptop-1", allow("devtool"));
  const onBox = await lease(srv, box2.key, { as: "devtool" });
  const onLaptop = await lease(srv, laptop.key, { as: "devtool" });

  // When the owner revokes "box-2"
  must(await stepped(owner, "POST", `/api/machines/${box2.id}/revoke`, {}, "machine.revoke", box2.id), "revoke");

  // Then every command of the "box-2" sessions exits 3 (the API says 401)
  expect((await whoamiApi(srv, onBox)).status).toBe(401);

  // And the "laptop-1" sessions keep working
  expect((await whoamiApi(srv, onLaptop)).status).toBe(200);
});

scenario("Disabling an identity ends its sessions on every machine", { tag: ["@api"] }, async ({ server }) => {
  // Given "devtool" sessions on "box-2" and "laptop-1" (and a "docs" session on "box-2")
  const srv = await server(apiServer());
  const owner = await bootstrapOwner(srv);
  const agents = await createAgents(owner, "devtool", "docs");
  const box2 = await loginMachine(srv, owner, "box-2", allow("devtool", "docs"));
  const laptop = await loginMachine(srv, owner, "laptop-1", allow("devtool"));
  const devOnBox = await lease(srv, box2.key, { as: "devtool" });
  const devOnLaptop = await lease(srv, laptop.key, { as: "devtool" });
  const docsOnBox = await lease(srv, box2.key, { as: "docs" });

  // When the owner disables "devtool" with a passkey
  must(await stepped(owner, "POST", `/api/identities/${agents.devtool!.id}/disable`, {}, "identity.disable", agents.devtool!.id), "disable");

  // Then the next command of both sessions exits 3 (the API says 401)
  expect([(await whoamiApi(srv, devOnBox)).status, (await whoamiApi(srv, devOnLaptop)).status]).toEqual([401, 401]);

  // And other identities on "box-2" still work
  expect((await whoamiApi(srv, docsOnBox)).status).toBe(200);
});

// ---- security: credentials -------------------------------------------------------------------------

scenario("A revoked machine key is refused", { tag: ["@api"] }, async ({ server }) => {
  // Given the owner revoked "box-2"
  const srv = await server(apiServer());
  const owner = await bootstrapOwner(srv);
  await createAgents(owner, "devtool");
  const box2 = await loginMachine(srv, owner, "box-2", allow("devtool"));
  must(await stepped(owner, "POST", `/api/machines/${box2.id}/revoke`, {}, "machine.revoke", box2.id), "revoke");

  // When "box-2" mints a session lease
  const res = await mintSession(srv, box2.key, { as: "devtool" });

  // Then the server answers 401
  expect(res.status).toBe(401);
});

scenario("No credential is stored in plain text", { tag: ["@api"] }, async ({ server, dataDir }) => {
  // Given a passkey device, recovery codes, a bootstrap link, a device code, a machine key and a session lease were issued
  const srv = await server(apiServer({ env: PLAIN }));
  const owner = await bootstrapOwner(srv);
  await createAgents(owner, "devtool");
  const box2 = await loginMachine(srv, owner, "box-2");
  const laptop = await loginMachine(srv, owner, "laptop-1");
  const token = await lease(srv, box2.key, { as: "devtool" });
  const secrets: Record<string, string> = {
    "bootstrap link": owner.link.token,
    "recovery code": owner.codes[0]!,
    "device cookie": owner.client.jar.get(DEVICE_COOKIE)!,
    "device code": box2.deviceCode,
    "machine key": box2.key,
    "session lease": token,
  };

  // When the data dir of the encryption-off test build is scanned
  const bytes = dataFileBytes(dataDir);
  expect(countOf(bytes, "devtool"), "the scan must read plain text: a handle is stored in the clear").toBeGreaterThan(0);

  // Then none of the fake token strings is found
  expect(Object.entries(secrets).filter(([, v]) => countOf(bytes, v) > 0).map(([k]) => k)).toEqual([]);

  // And the machine key copy cannot be decrypted after it is copied to another machine's record
  const db = plainDb(dataDir);
  try {
    const rows = db.prepare("SELECT id, key_enc FROM machines ORDER BY id").all() as { id: number; key_enc: Uint8Array }[];
    expect(rows).toHaveLength(2);
    db.prepare("UPDATE machines SET key_enc = ? WHERE id = ?").run(rows[0]!.key_enc, rows[1]!.id);
  } finally {
    db.close();
  }
  const reveal = await stepped(owner, "POST", `/api/machines/${laptop.id}/reveal`, {}, "machine.reveal", laptop.id);
  expect(reveal.status).toBeGreaterThanOrEqual(400);
  expect(reveal.text).not.toContain(box2.key);
  expect(reveal.text).not.toContain(laptop.key);
});

// ---- security: step-up -----------------------------------------------------------------------------

scenario("Step-up is required for destructive actions", { tag: ["@api"] }, async ({ server }) => {
  const srv = await server(apiServer());
  const owner = await bootstrapOwner(srv);
  const { devtool } = await createAgents(owner, "devtool");
  const box2 = await loginMachine(srv, owner, "box-2");
  const rows: [string, string, unknown][] = [
    ["POST", `/api/machines/${box2.id}/reveal`, {}],
    ["POST", `/api/machines/${box2.id}/regenerate`, {}],
    ["POST", `/api/machines/${box2.id}/revoke`, {}],
    ["PATCH", `/api/machines/${box2.id}`, { allow: ANY }],
    ["POST", "/api/crew/agents", { handle: "new-agent", display_name: "New Agent" }],
    ["POST", `/api/identities/${devtool!.id}/disable`, {}],
    ["POST", "/api/me/recovery-codes", {}],
  ];

  // When the owner calls <action> with no step-up
  const got: [number, string][] = [];
  for (const [method, route, body] of rows) {
    const res = await owner.client.request(method, route, { csrf: true, json: body });
    got.push([res.status, codeOf(res)]);
  }

  // Then the server answers 403 with the code "step_up_required"
  expect(got).toEqual(rows.map(() => [403, "step_up_required"]));
});

scenario("A step-up works once and for one action", { tag: ["@api"] }, async ({ server }) => {
  // Given the owner made a step-up for "machine.reveal" on "box-2"
  const srv = await server(apiServer());
  const owner = await bootstrapOwner(srv);
  const box2 = await loginMachine(srv, owner, "box-2");
  const su = await stepUp(owner, "machine.reveal", box2.id);

  // When the owner uses it to regenerate "box-2"
  const wrong = await owner.client.post(`/api/machines/${box2.id}/regenerate`, {}, withStepUp(su));

  // Then the server answers 403
  expect(wrong.status).toBe(403);

  // And a reveal of "box-2" with it answers 200
  expect((await owner.client.post(`/api/machines/${box2.id}/reveal`, {}, withStepUp(su))).status).toBe(200);

  // And a second reveal with it answers 403
  expect((await owner.client.post(`/api/machines/${box2.id}/reveal`, {}, withStepUp(su))).status).toBe(403);
});

scenario("A step-up expires after 5 minutes", { tag: ["@api"] }, async ({ server, testApi }) => {
  // Given the owner made a step-up for "machine.reveal" on "box-2" 5 minutes and 1 second ago
  const srv = await server(apiServer());
  const owner = await bootstrapOwner(srv);
  const box2 = await loginMachine(srv, owner, "box-2");
  const su = await stepUp(owner, "machine.reveal", box2.id);
  await testApi(srv).advanceClock(5 * MINUTE + 1_000);

  // When the owner reveals the key of "box-2" with it
  const res = await owner.client.post(`/api/machines/${box2.id}/reveal`, {}, withStepUp(su));

  // Then the server answers 403
  expect(res.status).toBe(403);
});

scenario("An agent credential can never step up", { tag: ["@api"] }, async ({ server }) => {
  // When the "devtool" lease calls POST /api/auth/step-up/options
  const srv = await server(apiServer());
  const owner = await bootstrapOwner(srv);
  await createAgents(owner, "devtool");
  const box2 = await loginMachine(srv, owner, "box-2", allow("devtool"));
  const token = await lease(srv, box2.key, { as: "devtool" });
  const options = await send(srv.target, "POST", "/api/auth/step-up/options", { json: { action: "machine.reveal", target_id: box2.id }, ...bearer(token) });

  // Then the server answers 403
  expect(options.status).toBe(403);

  // And a reveal of "box-2" with the lease answers 401
  const reveal = await send(srv.target, "POST", `/api/machines/${box2.id}/reveal`, { json: {}, ...bearer(token) });
  expect(reveal.status).toBe(401);
});

scenario("A used step-up cannot reveal again", { tag: ["@api"] }, async ({ server }) => {
  // Given the owner revealed the key of "box-2" with step-up "su_1"
  const srv = await server(apiServer());
  const owner = await bootstrapOwner(srv);
  const box2 = await loginMachine(srv, owner, "box-2");
  const su = await stepUp(owner, "machine.reveal", box2.id);
  must(await owner.client.post(`/api/machines/${box2.id}/reveal`, {}, withStepUp(su)), "first reveal");

  // When the owner reveals again with "su_1"
  const again = await owner.client.post(`/api/machines/${box2.id}/reveal`, {}, withStepUp(su));

  // Then the server answers 403
  expect(again.status).toBe(403);
});

// ---- security: reveal ------------------------------------------------------------------------------

scenario("The key never appears outside the reveal response", { tag: ["@api"] }, async ({ server, dataDir }) => {
  // Given the owner revealed and then regenerated the key of "box-2"
  const srv = await server(apiServer({ env: PLAIN }));
  const owner = await bootstrapOwner(srv);
  const box2 = await loginMachine(srv, owner, "box-2");
  const revealed = must(await stepped(owner, "POST", `/api/machines/${box2.id}/reveal`, {}, "machine.reveal", box2.id), "reveal").json();
  expect(revealed.machine_key).toBe(box2.key);
  const regenerated = must(await stepped(owner, "POST", `/api/machines/${box2.id}/regenerate`, {}, "machine.regenerate", box2.id), "regenerate").json();
  const keys = [...new Set<string>([box2.key, revealed.machine_key, regenerated.machine_key])];
  expect(keys).toHaveLength(2);

  // When the data dir of the encryption-off test build, the stored events, the audit view and the server log are scanned
  const bytes = dataFileBytes(dataDir);
  const db = plainDb(dataDir);
  let events: unknown[];
  try {
    events = db.prepare("SELECT type, payload FROM events").all();
  } finally {
    db.close();
  }
  const audit = must(await owner.client.get("/api/admin/audit"), "audit").text;
  expect(countOf(bytes, "box-2"), "the scan must read plain text: the machine name is stored in the clear").toBeGreaterThan(0);
  expect(events.length).toBeGreaterThan(0);
  const sources: Record<string, Buffer | string> = { "data file": bytes, "stored events": JSON.stringify(events), "audit view": audit, "server log": srv.log() };

  // Then the fake key strings appear 0 times outside the encrypted copy
  const counts = Object.fromEntries(Object.entries(sources).map(([name, hay]) => [name, keys.reduce((n, k) => n + countOf(hay, k), 0)]));
  expect(counts).toEqual({ "data file": 0, "stored events": 0, "audit view": 0, "server log": 0 });
});

scenario("A reveal response is never stored and its event holds no key", { tag: ["@api"] }, async ({ server, dataDir }) => {
  const srv = await server(apiServer({ env: PLAIN }));
  const owner = await bootstrapOwner(srv);
  const box2 = await loginMachine(srv, owner, "box-2");

  // When the owner reveals the key of "box-2" with a passkey
  const res = await stepped(owner, "POST", `/api/machines/${box2.id}/reveal`, {}, "machine.reveal", box2.id);
  expect(res.status).toBe(200);

  // Then the response has "Cache-Control: no-store"
  expect(String(res.headers["cache-control"])).toContain("no-store");

  // And the stored events hold one "machine.key_revealed" event without the key
  const db = plainDb(dataDir);
  try {
    const rows = db.prepare("SELECT type, payload FROM events WHERE type LIKE 'machine.key_revealed%'").all() as { type: string; payload: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.payload).not.toContain(box2.key);
  } finally {
    db.close();
  }
});

scenario("Regenerating a key stops the old key and its leases at once", { tag: ["@cli", "@api"] }, async ({ server }) => {
  // Given a "devtool" session on "box-2" is live, and a "devtool" session on "laptop-1" is live
  const srv = await server({ host: "localhost", adminSocket: true });
  const owner = await bootstrapOwner(srv);
  await createAgents(owner, "devtool");
  const box2 = await loginMachine(srv, owner, "box-2", allow("devtool"));
  const laptop = await loginMachine(srv, owner, "laptop-1", allow("devtool"));
  const onBox = await installedMachine(srv.origin, "box-2", box2.key);
  const onLaptop = await installedMachine(srv.origin, "laptop-1", laptop.key);
  const sidBox = sidOf(await onBox.sessionStart("devtool"));
  const sidLaptop = sidOf(await onLaptop.sessionStart("devtool"));

  // When the owner regenerates the key of "box-2"
  const regen = await stepped(owner, "POST", `/api/machines/${box2.id}/regenerate`, {}, "machine.regenerate", box2.id);
  expect(regen.status, regen.text).toBe(200);
  expect(regen.json().machine_key).not.toBe(box2.key);

  // Then the next request with the old key answers 401
  expect((await mintSession(srv, box2.key, { as: "devtool" })).status).toBe(401);

  // And the "box-2" lease answers 401 (the CLI exits 3)
  expect((await onBox.whoami(["--sid", sidBox])).code).toBe(3);

  // And the "laptop-1" session answers 200
  expect((await onLaptop.whoami(["--sid", sidLaptop])).code).toBe(0);
});
