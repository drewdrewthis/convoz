import fs from "node:fs";
import { installedMachine, modeOf, sidOf } from "../lib/cli.ts";
import type { ServerHandle, ServerOptions } from "../lib/fixtures.ts";
import {
  ANY,
  HOUR,
  MINUTE,
  allow,
  clientId,
  createAgent,
  createAgents,
  lease,
  loginMachine,
  mintSession,
  bearer,
  sessionsOf,
  stepped,
  whoamiApi,
  type Allow,
} from "../lib/machines.ts";
import { apiServer, bootstrapOwner, must } from "../lib/owner.ts";
import { send } from "../lib/http.ts";
import { expect, scenario } from "../lib/scenario.ts";

// The contract these bindings rely on is the comment block at the top of machine-login.spec.ts.

const POLL = { CONVOZ_TEST_POLL_MS: "250" };
const AGENTS = ["devtool", "dev-search", "docs", "release-bot"];
const CLAUDE = "claude-TESTONLY-7f3a";

/** Background: a fresh server with owner "drew", the four agents, and machine "box-2" with allow-list "devtool" and "dev-*". */
async function background(server: (o?: ServerOptions) => Promise<ServerHandle>, o: { cli?: boolean; scopes?: string[]; list?: Allow } = {}) {
  const srv = await server(o.cli ? { host: "localhost", adminSocket: true, env: POLL } : apiServer());
  const owner = await bootstrapOwner(srv);
  const agents = await createAgents(owner, ...AGENTS);
  const box2 = await loginMachine(srv, owner, "box-2", o.list ?? allow("devtool", "dev-*"), o.scopes ? { scopes: o.scopes } : {});
  return { srv, owner, agents, box2 };
}

scenario("Session start prints only a local session id", { tag: ["@cli"] }, async ({ server }) => {
  const { srv, box2 } = await background(server, { cli: true });
  const box = await installedMachine(srv.origin, "box-2", box2.key);

  // When "convoz session start --as devtool" runs on "box-2"
  const res = await box.sessionStart("devtool");

  // Then the CLI prints one line "CONVOZ_SID=a1b2c3"
  expect(res.code, res.stderr).toBe(0);
  expect(res.stdout).toMatch(/^CONVOZ_SID=[0-9a-f]{6,}\n$/);
  expect(res.stderr).toBe("");
  const sid = sidOf(res);

  // And the output contains no "cvz_s_" or "cvz_m_" string
  expect(res.stdout + res.stderr).not.toMatch(/cvz_[sm]_/);

  // And "~/.config/convoz/sessions/a1b2c3" exists with mode 0600
  expect(modeOf(box.sessionPath(sid))).toBe(0o600);

  // And "convoz whoami --sid a1b2c3" names identity "devtool", machine "box-2" and this session
  const who = await box.whoami(["--sid", sid]);
  expect(who.code, who.stderr).toBe(0);
  expect(who.stdout).toContain("identity: devtool");
  expect(who.stdout).toContain("machine: box-2");
  expect(who.stdout).toContain(`session: ${sid}`);
});

scenario("Two machines run the same identity at once", { tag: ["@api"] }, async ({ server }) => {
  const { srv, owner, box2 } = await background(server);

  // Given machine "laptop-1" is logged in with allow-list "devtool"
  const laptop = await loginMachine(srv, owner, "laptop-1", allow("devtool"));

  // When both "box-2" and "laptop-1" start a session as "devtool"
  const a = await lease(srv, box2.key, { as: "devtool" });
  const b = await lease(srv, laptop.key, { as: "devtool" });

  // Then "convoz whoami" works on both machines
  const onBox = await whoamiApi(srv, a);
  const onLaptop = await whoamiApi(srv, b);
  expect([onBox.status, onLaptop.status]).toEqual([200, 200]);

  // And "convoz whoami" on each machine lists 2 live sessions of "devtool"
  expect(onBox.json().live_sessions).toBe(2);
  expect(onLaptop.json().live_sessions).toBe(2);
  expect(onBox.json().machine.name).toBe("box-2");
  expect(onLaptop.json().machine.name).toBe("laptop-1");
});

scenario("A lease renews while the session works", { tag: ["@cli"] }, async ({ server, testApi }) => {
  // Given a session of "devtool" started 11 hours ago and made a call 1 minute ago
  const { srv, box2 } = await background(server, { cli: true });
  const clock = testApi(srv);
  const box = await installedMachine(srv.origin, "box-2", box2.key);
  const sid = sidOf(await box.sessionStart("devtool", [], { claude: CLAUDE }));
  await clock.advanceClock(10 * HOUR + 59 * MINUTE);
  expect((await box.whoami(["--sid", sid])).code).toBe(0);
  await clock.advanceClock(MINUTE);

  // When the test clock moves forward 2 hours with one CLI call every 10 minutes
  const codes: (number | null)[] = [];
  for (let i = 0; i < 12; i++) {
    await clock.advanceClock(10 * MINUTE);
    codes.push((await box.whoami(["--sid", sid])).code);
  }

  // Then every call works
  expect(codes).toEqual(Array(12).fill(0));
});

scenario("An idle lease expires after 12 hours", { tag: ["@cli"] }, async ({ server, testApi }) => {
  // Given a session of "devtool" that made no call for 12 hours and 1 minute
  const { srv, box2 } = await background(server, { cli: true });
  const box = await installedMachine(srv.origin, "box-2", box2.key);
  const sid = sidOf(await box.sessionStart("devtool", [], { claude: CLAUDE }));
  await testApi(srv).advanceClock(12 * HOUR + MINUTE);

  // When it calls "convoz whoami"
  const res = await box.whoami(["--sid", sid]);

  // Then the CLI exits 3 with the message that the session ended
  expect(res.code).toBe(3);
  expect(res.stderr).toMatch(/session ended/i);

  // And "convoz session start --as devtool" gives a working session
  const fresh = await box.sessionStart("devtool", [], { claude: CLAUDE });
  expect(fresh.code, fresh.stderr).toBe(0);
  expect((await box.whoami(["--sid", sidOf(fresh)])).code).toBe(0);
});

scenario("Ending a session ends its lease", { tag: ["@cli"] }, async ({ server }) => {
  // Given a session of "devtool" with session id "a1b2c3"
  const { srv, owner, box2 } = await background(server, { cli: true });
  const box = await installedMachine(srv.origin, "box-2", box2.key);
  const sid = sidOf(await box.sessionStart("devtool"));
  const token = box.leaseOf(sid);

  // When "convoz session end --sid a1b2c3" runs
  const end = await box.sessionEnd(sid);
  expect(end.code, end.stderr).toBe(0);

  // Then "convoz whoami --sid a1b2c3" exits 3
  expect((await box.whoami(["--sid", sid])).code).toBe(3);
  expect((await whoamiApi(srv, token)).status).toBe(401);

  // And Crew → Sessions shows the session as ended
  const rows = (await sessionsOf(owner)).filter((r) => r.identity === "devtool");
  expect(rows.map((r) => [r.state, r.end_reason])).toEqual([["ended", "logout"]]);
});

scenario("The CLI refuses a session file with loose permissions", { tag: ["@cli"] }, async ({ server }) => {
  // Given the session file of "a1b2c3" has mode 0644
  const { srv, box2 } = await background(server, { cli: true });
  const box = await installedMachine(srv.origin, "box-2", box2.key);
  const sid = sidOf(await box.sessionStart("devtool"));
  fs.chmodSync(box.sessionPath(sid), 0o644);

  // When "convoz whoami --sid a1b2c3" runs
  const res = await box.whoami(["--sid", sid]);

  // Then the CLI exits 3 and names the file and the mode it needs
  expect(res.code).toBe(3);
  expect(res.stderr).toContain(box.sessionPath(sid));
  expect(res.stderr).toContain("0600");
});

scenario("A machine with create_identity makes a new identity", { tag: ["@cli"] }, async ({ server }) => {
  // Given "box-2" has the create_identity scope
  const { srv, owner, box2 } = await background(server, { cli: true, scopes: ["read", "post", "ask", "status", "upload", "create_identity"] });
  const box = await installedMachine(srv.origin, "box-2", box2.key);

  // When "convoz session start --as dev-ci --create --name 'CI helper'" runs on "box-2"
  const res = await box.sessionStart("dev-ci", ["--create", "--name", "CI helper"]);
  expect(res.code, res.stderr).toBe(0);

  // Then the session works as "dev-ci"
  const who = await box.whoami(["--sid", sidOf(res)]);
  expect(who.code, who.stderr).toBe(0);
  expect(who.stdout).toContain("identity: dev-ci");

  // And Crew shows "CI helper @dev-ci" marked "created by box-2"
  const list = must(await owner.client.get("/api/identities"), "identities").json().identities as { handle: string; display_name: string; created_by?: { kind: string; name: string } }[];
  const row = list.find((i) => i.handle === "dev-ci");
  expect(row?.display_name).toBe("CI helper");
  expect(row?.created_by).toEqual({ kind: "machine", name: "box-2" });
});

// ---- contracts -------------------------------------------------------------------------------------

scenario("The allow-list decides which identities a machine may use", { tag: ["@api"] }, async ({ server }) => {
  const { srv, owner } = await background(server);
  const rows: { mode: "list" | "any"; entries: string[]; identity: string; status: number }[] = [
    { mode: "list", entries: ["devtool"], identity: "devtool", status: 201 },
    { mode: "list", entries: ["devtool"], identity: "release-bot", status: 403 },
    { mode: "list", entries: ["dev-*"], identity: "dev-search", status: 201 },
    { mode: "list", entries: ["dev-*"], identity: "docs", status: 403 },
    { mode: "any", entries: [], identity: "docs", status: 201 },
  ];

  // Given machine "laptop-1" is logged in with allow mode <mode> and entries <entries>; When "laptop-1" asks for a lease as <identity>
  const got: number[] = [];
  for (const [i, row] of rows.entries()) {
    const m = await loginMachine(srv, owner, `laptop-${i + 1}`, row.mode === "any" ? ANY : allow(...row.entries));
    got.push((await mintSession(srv, m.key, { as: row.identity })).status);
  }

  // Then the server answers <status>
  expect(got).toEqual(rows.map((r) => r.status));
});

scenario("A disabled identity cannot start a session", { tag: ["@api"] }, async ({ server }) => {
  // Given the owner disabled "dev-search"
  const { srv, owner, agents, box2 } = await background(server);
  must(await stepped(owner, "POST", `/api/identities/${agents["dev-search"]!.id}/disable`, {}, "identity.disable", agents["dev-search"]!.id), "disable");

  // When "box-2" asks for a lease as "dev-search"
  const res = await mintSession(srv, box2.key, { as: "dev-search" });

  // Then the server answers 403
  expect(res.status).toBe(403);
});

scenario("A human identity cannot be a session identity", { tag: ["@api"] }, async ({ server }) => {
  // When "box-2" asks for a lease as "drew"
  const { srv, box2 } = await background(server, { list: ANY });
  const res = await mintSession(srv, box2.key, { as: "drew" });

  // Then the server answers 403
  expect(res.status).toBe(403);
});

scenario("The machine key works only to mint leases", { tag: ["@api"] }, async ({ server }) => {
  const { srv, box2 } = await background(server);

  // When "box-2" calls GET /api/inbox with its machine key instead of a lease
  const inbox = await send(srv.target, "GET", "/api/inbox", bearer(box2.key));

  // Then the server answers 401
  expect(inbox.status).toBe(401);
  expect((await send(srv.target, "GET", "/api/me", bearer(box2.key))).status).toBe(401);

  // And POST /api/sessions with the same key answers 201
  expect((await mintSession(srv, box2.key, { as: "devtool" })).status).toBe(201);
});

scenario("Re-minting with the same client id ends the old lease", { tag: ["@api"] }, async ({ server }) => {
  // Given "box-2" holds lease A as "devtool" for client id "claude-7f3a"
  const { srv, box2 } = await background(server);
  const leaseA = await lease(srv, box2.key, { as: "devtool", clientId: CLAUDE });

  // When "box-2" mints again as "devtool" with client id "claude-7f3a"
  const leaseB = await lease(srv, box2.key, { as: "devtool", clientId: CLAUDE });

  // Then the server returns lease B that is different from lease A
  expect(leaseB).not.toBe(leaseA);

  // And a request with lease B answers 200
  expect((await whoamiApi(srv, leaseB)).status).toBe(200);

  // And a request with lease A answers 401
  expect((await whoamiApi(srv, leaseA)).status).toBe(401);
});

scenario("An expired session is ended before a new lease is minted", { tag: ["@api"] }, async ({ server, testApi }) => {
  // Given "box-2" held a lease as "devtool" for client id "claude-7f3a" that expired 1 hour ago
  const { srv, owner, box2 } = await background(server);
  const old = await lease(srv, box2.key, { as: "devtool", clientId: CLAUDE });
  await testApi(srv).advanceClock(13 * HOUR);
  expect((await whoamiApi(srv, old)).status).toBe(401);

  // When "box-2" mints again as "devtool" with client id "claude-7f3a"
  const res = await mintSession(srv, box2.key, { as: "devtool", clientId: CLAUDE });

  // Then the server answers 201 with a new lease
  expect(res.status).toBe(201);
  expect(res.json().lease).not.toBe(old);

  // And Crew → Sessions shows one live session for client id "claude-7f3a"
  const rows = (await sessionsOf(owner)).filter((r) => r.client_id === CLAUDE);
  expect(rows.filter((r) => r.state === "live")).toHaveLength(1);
  expect(rows.filter((r) => r.state === "ended").map((r) => r.end_reason)).toEqual(["expired"]);
});

scenario("Two concurrent re-mints with one client id leave one working lease", { tag: ["@api"] }, async ({ server }) => {
  const { srv, owner, box2 } = await background(server);
  const working: number[] = [];
  const liveRows: number[] = [];

  // When "box-2" sends two lease requests as "devtool" with client id "claude-7f3a" at the same time (five rounds, one client id each)
  for (let round = 0; round < 5; round++) {
    const id = `${CLAUDE}-${round}`;
    const both = await Promise.all([mintSession(srv, box2.key, { as: "devtool", clientId: id }), mintSession(srv, box2.key, { as: "devtool", clientId: id })]);
    expect(both.map((r) => r.status)).toEqual([201, 201]);

    // Then exactly one of the two returned leases answers 200 on GET /api/me
    const answers = await Promise.all(both.map((r) => whoamiApi(srv, r.json().lease)));
    working.push(answers.filter((a) => a.status === 200).length);

    // And Crew → Sessions shows one live session for client id "claude-7f3a"
    liveRows.push((await sessionsOf(owner)).filter((r) => r.client_id === id && r.state === "live").length);
  }
  expect(working).toEqual([1, 1, 1, 1, 1]);
  expect(liveRows).toEqual([1, 1, 1, 1, 1]);
});

scenario("The 21st live session of one identity is refused", { tag: ["@api"] }, async ({ server }) => {
  // Given 20 live sessions of "devtool" on "box-2"
  const { srv, box2 } = await background(server);
  const first: number[] = [];
  for (let i = 0; i < 20; i++) first.push((await mintSession(srv, box2.key, { as: "devtool" })).status);
  expect(first).toEqual(Array(20).fill(201));

  // When "box-2" asks for one more lease as "devtool" with a new client id
  const res = await mintSession(srv, box2.key, { as: "devtool", clientId: clientId() });

  // Then the server answers 429 with the code "session_cap"
  expect(res.status).toBe(429);
  expect(res.json().error.code).toBe("session_cap");
});

scenario("The 201st live session on one machine is refused", { tag: ["@api"] }, async ({ server }, info) => {
  info.setTimeout(90_000);
  // Given 200 live sessions on "box-2" across 10 identities (the machine allows any agent here, so the 10 can differ from the Background)
  const { srv, owner, box2 } = await background(server, { list: ANY });
  const handles = Array.from({ length: 10 }, (_, i) => `bulk-${String(i + 1).padStart(2, "0")}`);
  for (const h of handles) await createAgent(owner, h);
  const statuses: number[] = [];
  for (const h of handles) for (let i = 0; i < 20; i++) statuses.push((await mintSession(srv, box2.key, { as: h })).status);
  expect(statuses.every((s) => s === 201)).toBe(true);

  // When "box-2" asks for one more lease
  const res = await mintSession(srv, box2.key, { as: "docs" });

  // Then the server answers 429 with the code "session_cap"
  expect(res.status).toBe(429);
  expect(res.json().error.code).toBe("session_cap");
});

scenario("Lease mints are budgeted per identity", { tag: ["@api"] }, async ({ server }) => {
  // Given "box-2" minted 30 leases as "devtool" in the last hour (one client id, so each mint replaces the one before)
  const { srv, box2 } = await background(server);
  const statuses: number[] = [];
  for (let i = 0; i < 30; i++) statuses.push((await mintSession(srv, box2.key, { as: "devtool", clientId: CLAUDE })).status);
  expect(statuses).toEqual(Array(30).fill(201));

  // When it mints one more as "devtool"
  const res = await mintSession(srv, box2.key, { as: "devtool", clientId: CLAUDE });

  // Then the server answers 429 with a Retry-After header
  expect(res.status).toBe(429);
  expect(Number(res.headers["retry-after"])).toBeGreaterThan(0);
});

scenario("Removing an identity from the allow-list ends its leases on that machine", { tag: ["@cli", "@api"] }, async ({ server }) => {
  // Given live sessions of "dev-search" on "box-2" and on "laptop-1"
  const { srv, owner, box2 } = await background(server, { cli: true });
  const laptop1 = await loginMachine(srv, owner, "laptop-1", allow("devtool", "dev-*"));
  const onBox = await installedMachine(srv.origin, "box-2", box2.key);
  const onLaptop = await installedMachine(srv.origin, "laptop-1", laptop1.key);
  const sidBox = sidOf(await onBox.sessionStart("dev-search"));
  const sidLaptop = sidOf(await onLaptop.sessionStart("dev-search"));
  expect((await onBox.whoami(["--sid", sidBox])).code).toBe(0);

  // When the owner removes "dev-*" from the allow-list of "box-2" with a passkey
  const patch = await stepped(owner, "PATCH", `/api/machines/${box2.id}`, { allow: allow("devtool") }, "machine.allow", box2.id);
  expect(patch.status, patch.text).toBe(200);

  // Then the next request of the "box-2" session answers 401 (the CLI exits 3)
  expect((await onBox.whoami(["--sid", sidBox])).code).toBe(3);

  // And the "laptop-1" session still answers 200
  expect((await onLaptop.whoami(["--sid", sidLaptop])).code).toBe(0);
});

scenario("A machine without create_identity cannot make identities", { tag: ["@api"] }, async ({ server }) => {
  const { srv, owner, box2 } = await background(server);

  // When "box-2" asks for a lease as "dev-new" with create set
  const res = await mintSession(srv, box2.key, { as: "dev-new", create: { display_name: "Dev New" } });

  // Then the server answers 403
  expect(res.status).toBe(403);

  // And Crew does not list "dev-new"
  const list = must(await owner.client.get("/api/identities"), "identities").json().identities as { handle: string }[];
  expect(list.map((i) => i.handle)).not.toContain("dev-new");
});

scenario("A machine creates at most 5 identities per day", { tag: ["@api"] }, async ({ server }) => {
  // Given "box-2" has the create_identity scope and created 5 identities today
  const { srv, box2 } = await background(server, { scopes: ["read", "post", "ask", "status", "upload", "create_identity"] });
  const first: number[] = [];
  for (let i = 1; i <= 5; i++) first.push((await mintSession(srv, box2.key, { as: `dev-n${i}`, create: { display_name: `Dev Number ${i}` } })).status);
  expect(first).toEqual(Array(5).fill(201));

  // When it creates a sixth
  const res = await mintSession(srv, box2.key, { as: "dev-n6", create: { display_name: "Dev Number 6" } });

  // Then the server answers 429
  expect(res.status).toBe(429);
});
