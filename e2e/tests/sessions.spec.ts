import fs from "node:fs";
import { installedMachine, modeOf, sidOf, type CliMachine, type Running } from "../lib/cli.ts";
import type { ServerHandle, ServerOptions } from "../lib/fixtures.ts";
import {
  ANY,
  HOUR,
  MINUTE,
  allow,
  approveIdentity,
  clientId,
  createAgent,
  createAgents,
  declineCard,
  denyIdentity,
  identityRequests,
  lease,
  loginMachine,
  mintSession,
  bearer,
  sessionsOf,
  signInBrowser,
  revokeAgentKey,
  stepped,
  whoamiApi,
  type Allow,
} from "../lib/machines.ts";
import { createConversation, ownerSays } from "../lib/chat.ts";
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

const WATCH_NEXT = "Next: start `convoz watch --json` now and keep it running: it prints one line per message or ask for you. Answer, then `convoz ack <ack>`.";

scenario("Session start tells the agent to start watching its inbox at once", { tag: ["@cli"] }, async ({ server }) => {
  const { srv, box2 } = await background(server, { cli: true });
  const box = await installedMachine(srv.origin, "box-2", box2.key);

  // When "convoz session start --as devtool" runs on "box-2"
  const res = await box.sessionStart("devtool");

  // Then stderr says to start "convoz watch --json" and stdout stays one CONVOZ_SID line
  expect(res.code, res.stderr).toBe(0);
  expect(res.stderr).toBe(WATCH_NEXT + "\n");
  expect(res.stdout).toMatch(/^CONVOZ_SID=[0-9a-f]{6,}\n$/);
});

scenario("Session start prints only a local session id", { tag: ["@cli"] }, async ({ server }) => {
  const { srv, box2 } = await background(server, { cli: true });
  const box = await installedMachine(srv.origin, "box-2", box2.key);

  // When "convoz session start --as devtool" runs on "box-2"
  const res = await box.sessionStart("devtool");

  // Then the CLI prints one line "CONVOZ_SID=a1b2c3"
  expect(res.code, res.stderr).toBe(0);
  expect(res.stdout).toMatch(/^CONVOZ_SID=[0-9a-f]{6,}\n$/);
  expect(res.stderr).toBe(WATCH_NEXT + "\n");
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

  // And no card appears in Now
  expect(await identityRequests(owner)).toEqual([]);
});

scenario("The display name is optional and defaults to the handle", { tag: ["@cli"] }, async ({ server }) => {
  // Given "box-2" has the create_identity scope
  const { srv, owner, box2 } = await background(server, { cli: true, scopes: ["read", "post", "ask", "status", "upload", "create_identity"] });
  const box = await installedMachine(srv.origin, "box-2", box2.key);

  // When "convoz session start --as dev-ci --create --description 'Runs CI'" runs on "box-2"
  const res = await box.sessionStart("dev-ci", ["--create", "--description", "Runs CI"]);
  expect(res.code, res.stderr).toBe(0);

  // Then the session works as "dev-ci"
  const who = await box.whoami(["--sid", sidOf(res)]);
  expect(who.stdout).toContain("identity: dev-ci");

  // And Crew shows "dev-ci" with the line "Runs CI"
  const list = must(await owner.client.get("/api/identities"), "identities").json().identities as { handle: string; display_name: string; description?: string }[];
  const row = list.find((i) => i.handle === "dev-ci");
  expect(row?.display_name).toBe("dev-ci");
  expect(row?.description).toBe("Runs CI");
});

/** `convoz session start --as H --create ...` left waiting for the owner; resolves once it said so. */
async function startAsking(box: CliMachine, handle: string, extra: string[] = []): Promise<Running> {
  const run = box.start(["session", "start", "--as", handle, "--create", ...extra]);
  await expect.poll(() => run.stderr(), { message: "the CLI says it waits for the owner" }).toMatch(/Waiting for the owner/);
  return run;
}

scenario("A machine without create_identity files a request that the owner approves", { tag: ["@cli", "@browser"] }, async ({ server, page, context }) => {
  // Given "box-2" is logged in without the create_identity scope
  const { srv, owner, box2 } = await background(server, { cli: true });
  const box = await installedMachine(srv.origin, "box-2", box2.key);

  // When "convoz session start --as dev-ci --create --description 'Runs CI'" runs on "box-2"
  const run = await startAsking(box, "dev-ci", ["--description", "Runs CI"]);

  // Then the CLI says it is waiting for the owner and does not exit
  expect(await Promise.race([run.done.then(() => "exited"), new Promise((r) => setTimeout(() => r("waiting"), 700))])).toBe("waiting");

  // And the owner sees one Now card "box-2 wants to connect as @dev-ci" with "Runs CI" labelled "From the agent"
  await signInBrowser(srv, owner, page, context);
  await expect(page.getByRole("article")).toHaveCount(1);
  const card = page.getByRole("article", { name: "box-2 wants to connect as @dev-ci", exact: true });
  await expect(card).toContainText("From the agent");
  await expect(card).toContainText("Runs CI");

  // When the owner taps Approve on that card
  await card.getByRole("button", { name: "Approve", exact: true }).click();

  // Then the CLI prints CONVOZ_SID and exits 0
  const done = await run.done;
  expect(done.code, done.stderr).toBe(0);
  const sid = sidOf(done);

  // And the session works as "dev-ci"
  const who = await box.whoami(["--sid", sid]);
  expect(who.stdout).toContain("identity: dev-ci");

  // And Crew shows "dev-ci" marked "created by box-2"
  const list = must(await owner.client.get("/api/identities"), "identities").json().identities as { handle: string; created_by?: { kind: string; name: string } }[];
  expect(list.find((i) => i.handle === "dev-ci")?.created_by).toEqual({ kind: "machine", name: "box-2" });

  // And "box-2" allows "dev-ci" now
  const machines = must(await owner.client.get("/api/machines"), "machines").json().machines as { allow: Allow }[];
  expect(machines[0]!.allow.identities).toContain("dev-ci");
});

scenario("Declining an agent request ends the waiting command", { tag: ["@cli", "@browser"] }, async ({ server, page, context }) => {
  // Given "box-2" is logged in without the create_identity scope
  const { srv, owner, box2 } = await background(server, { cli: true });
  const box = await installedMachine(srv.origin, "box-2", box2.key);

  // When "convoz session start --as dev-ci --create" runs on "box-2"
  const run = await startAsking(box, "dev-ci");

  // And the owner taps Decline on the card "box-2 wants to connect as @dev-ci"
  await signInBrowser(srv, owner, page, context);
  await declineCard(page, "box-2");

  // Then the CLI exits 3 with a message that the owner denied the request
  const done = await run.done;
  expect(done.code, done.stderr).toBe(3);
  expect(done.stderr).toMatch(/owner denied the request/i);

  // And Crew does not list "dev-ci"
  const list = must(await owner.client.get("/api/identities"), "identities").json().identities as { handle: string }[];
  expect(list.map((i) => i.handle)).not.toContain("dev-ci");
});

scenario("Asking for a handle that exists is refused and never takes it over", { tag: ["@cli"] }, async ({ server }) => {
  // Given "box-2" does not allow "docs" and "docs" exists
  const { srv, owner, box2 } = await background(server, { cli: true });
  const box = await installedMachine(srv.origin, "box-2", box2.key);

  // When "convoz session start --as docs --create" runs on "box-2"
  const res = await box.sessionStart("docs", ["--create"]);

  // Then the CLI exits 4 and says the handle is taken and to ask the owner to allow it on the machine
  expect(res.code, res.stderr).toBe(4);
  expect(res.stderr).toMatch(/taken/i);
  expect(res.stderr).toMatch(/allow it on this machine/i);

  // And no card appears in Now
  expect(await identityRequests(owner)).toEqual([]);
});

scenario("Running the same command again after the approval just starts the session", { tag: ["@cli"] }, async ({ server }) => {
  // Given the owner approved the request of "box-2" for "dev-ci"
  const { srv, owner, box2 } = await background(server, { cli: true });
  const box = await installedMachine(srv.origin, "box-2", box2.key);
  const run = await startAsking(box, "dev-ci");
  const [req] = await identityRequests(owner);
  must(await approveIdentity(owner, req!.ref), "approve", 201);
  expect((await run.done).code).toBe(0);

  // When "convoz session start --as dev-ci --create" runs on "box-2" again
  const again = await box.sessionStart("dev-ci", ["--create"]);

  // Then the session works as "dev-ci"
  expect(again.code, again.stderr).toBe(0);
  const who = await box.whoami(["--sid", sidOf(again)]);
  expect(who.stdout).toContain("identity: dev-ci");

  // And no second agent and no second card exist
  const list = must(await owner.client.get("/api/identities"), "identities").json().identities as { handle: string }[];
  expect(list.filter((i) => i.handle === "dev-ci")).toHaveLength(1);
  expect(await identityRequests(owner)).toEqual([]);
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
  must(await revokeAgentKey(owner, agents["dev-search"]!.id), "disable");

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

scenario("A machine without create_identity gets a request, not an identity", { tag: ["@api"] }, async ({ server }) => {
  const { srv, owner, box2 } = await background(server);

  // When "box-2" asks for a lease as "dev-new" with create set
  const res = await mintSession(srv, box2.key, { as: "dev-new", create: { display_name: "Dev New" } });

  // Then the server answers 202 with an unguessable request ref
  expect(res.status, res.text).toBe(202);
  const ref = res.json().request.ref as string;
  expect(ref).toMatch(/^idr_[0-9a-f]{32}$/);

  // And Crew does not list "dev-new"
  const list = must(await owner.client.get("/api/identities"), "identities").json().identities as { handle: string }[];
  expect(list.map((i) => i.handle)).not.toContain("dev-new");

  // And asking again with the ref answers 202 until the owner decides
  const again = await mintSession(srv, box2.key, { as: "dev-new", create: { request: ref } });
  expect(again.status).toBe(202);
  expect(again.json().request.ref).toBe(ref);
});

scenario("A request for a bad or taken handle is refused when it is filed", { tag: ["@api"] }, async ({ server }) => {
  const { srv, owner, box2 } = await background(server);
  const rows: [string, number, string][] = [
    ["docs", 409, "handle_taken"], // exists, and "box-2" may not act as it
    ["admin", 400, "invalid_request"],
    ["devtoo1", 400, "invalid_request"], // a look-alike of "devtool"
  ];

  // When "box-2" asks for a lease as <handle> with create set
  const got: [string, number, string][] = [];
  for (const [handle] of rows) {
    const res = await mintSession(srv, box2.key, { as: handle, create: {} });
    got.push([handle, res.status, res.json().error?.code]);
  }

  // Then the server answers <status> with the code <code>
  expect(got).toEqual(rows);

  // And GET /api/now lists no identity request
  expect(await identityRequests(owner)).toEqual([]);
});

scenario("A request that waits does not reserve its handle", { tag: ["@api"] }, async ({ server }) => {
  // Given "box-2" filed a request for "dev-new" and "laptop-1" filed one too
  const { srv, owner, box2 } = await background(server);
  const laptop = await loginMachine(srv, owner, "laptop-1", allow("dev-*"));
  expect((await mintSession(srv, box2.key, { as: "dev-new", create: {} })).status).toBe(202);
  expect((await mintSession(srv, laptop.key, { as: "dev-new", create: {} })).status).toBe(202);
  const [first, second] = await identityRequests(owner);
  const ofLaptop = [first!, second!].find((r) => r.machine === "laptop-1")!;
  const ofBox = [first!, second!].find((r) => r.machine === "box-2")!;

  // When the owner approves the request of "laptop-1"
  must(await approveIdentity(owner, ofLaptop.ref), "approve laptop-1", 201);

  // Then approving the request of "box-2" answers 409 with the code "handle_taken"
  const res = await approveIdentity(owner, ofBox.ref);
  expect(res.status).toBe(409);
  expect(res.json().error.code).toBe("handle_taken");
});

scenario("The approval checks the look-alike rule again", { tag: ["@api"] }, async ({ server }) => {
  // Given "box-2" filed a request for "dev-new"
  const { srv, owner, box2 } = await background(server);
  expect((await mintSession(srv, box2.key, { as: "dev-new", create: {} })).status).toBe(202);
  const [req] = await identityRequests(owner);

  // And another agent then took the display name "dev-new"
  const box = await loginMachine(srv, owner, "laptop-1", allow("docs"));
  const token = await lease(srv, box.key, { as: "docs" });
  must(await send(srv.target, "PATCH", "/api/me/profile", { json: { display_name: "dev-new" }, ...bearer(token) }), "rename docs");

  // When the owner approves the request
  const res = await approveIdentity(owner, req!.ref);

  // Then the server answers 400 naming "handle"
  expect(res.status, res.text).toBe(400);
  expect(res.json().error.field).toBe("handle");
});

scenario("Only the machine that filed a request can ask about it", { tag: ["@api"] }, async ({ server }) => {
  // Given "box-2" filed a request for "dev-new"
  const { srv, owner, box2 } = await background(server);
  const laptop = await loginMachine(srv, owner, "laptop-1", allow("dev-*"));
  const mine = await mintSession(srv, box2.key, { as: "dev-new", create: {} });
  const ref = mine.json().request.ref as string;
  const other = await mintSession(srv, box2.key, { as: "dev-other", create: {} });

  // When "laptop-1" asks with the ref of that request
  const stolen = await mintSession(srv, laptop.key, { as: "dev-new", create: { request: ref } });
  const unknown = await mintSession(srv, laptop.key, { as: "dev-new", create: { request: "idr_" + "0".repeat(32) } });

  // Then the server answers 404, the same as for a ref that never existed
  expect([stolen.status, unknown.status]).toEqual([404, 404]);
  expect(stolen.text).toBe(unknown.text);

  // And the ref is "idr_" and 32 hex characters, different for every request
  expect(other.json().request.ref).toMatch(/^idr_[0-9a-f]{32}$/);
  expect(other.json().request.ref).not.toBe(ref);
});

scenario("A request expires after 24 hours and the command is told", { tag: ["@api"] }, async ({ server, testApi }) => {
  // Given "box-2" filed a request for "dev-new"
  const { srv, owner, box2 } = await background(server);
  const filed = await mintSession(srv, box2.key, { as: "dev-new", create: {} });
  const ref = filed.json().request.ref as string;

  // When the test clock moves forward 24 hours and 1 second
  await testApi(srv).advanceClock(24 * HOUR + 1_000);

  // Then asking with the ref answers 410 with the code "request_expired"
  const res = await mintSession(srv, box2.key, { as: "dev-new", create: { request: ref } });
  expect(res.status).toBe(410);
  expect(res.json().error.code).toBe("request_expired");

  // And Now lists no identity request
  expect(await identityRequests(owner)).toEqual([]);

  // And the handle "dev-new" is still free
  const again = await mintSession(srv, box2.key, { as: "dev-new", create: {} });
  expect(again.status).toBe(202);
});

scenario("A machine files at most 5 requests in a day", { tag: ["@api"] }, async ({ server }) => {
  // Given "box-2" filed 5 requests today
  const { srv, box2 } = await background(server);
  for (let i = 1; i <= 5; i++) expect((await mintSession(srv, box2.key, { as: `dev-n${i}`, create: {} })).status).toBe(202);

  // When it files a sixth
  const res = await mintSession(srv, box2.key, { as: "dev-n6", create: {} });

  // Then the server answers 429 with a Retry-After header
  expect(res.status).toBe(429);
  expect(Number(res.headers["retry-after"])).toBeGreaterThanOrEqual(1);
});

scenario("Only the owner's session can decide an agent request", { tag: ["@api"] }, async ({ server }) => {
  // Given "box-2" filed a request for "dev-new"
  const { srv, owner, box2 } = await background(server);
  const token = await lease(srv, box2.key, { as: "devtool" });
  expect((await mintSession(srv, box2.key, { as: "dev-new", create: {} })).status).toBe(202);
  const [req] = await identityRequests(owner);
  const routes = [`/api/identity-requests/${req!.ref}/approve`, `/api/identity-requests/${req!.ref}/deny`];

  // When a machine key, a session lease and a caller with no credential each try to approve or decline it
  const got: number[] = [];
  for (const route of routes) {
    got.push((await send(srv.target, "POST", route, { json: {}, ...bearer(box2.key) })).status);
    got.push((await send(srv.target, "POST", route, { json: {}, ...bearer(token) })).status);
    got.push((await send(srv.target, "POST", route, { json: {} })).status);
  }

  // Then the server answers 401 every time
  expect(got.every((status) => status === 401 || status === 403)).toBe(true);
  expect(got).not.toContain(200);

  // And the owner approves it with no step-up and the agent exists
  must(await approveIdentity(owner, req!.ref), "approve", 201);
  const list = must(await owner.client.get("/api/identities"), "identities").json().identities as { handle: string }[];
  expect(list.map((i) => i.handle)).toContain("dev-new");
  expect(denyIdentity).toBeDefined();
});

scenario("The card data is plain text, the avatar is cleaned and the join goes through the participants path", { tag: ["@api"] }, async ({ server }) => {
  // Given "box-2" filed a request for "dev-new" with the description "<b>**hi**</b>", a script in its SVG avatar and conversation 41
  const { srv, owner, box2 } = await background(server);
  const conv = await createConversation(owner, { participants: ["devtool"], title: "Ship search filters" });
  const before = await ownerSays(owner, conv, "before the add");
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><script>alert(1)</script><circle cx="5" cy="5" r="4"/></svg>';
  const filed = await mintSession(srv, box2.key, { as: "dev-new", create: { description: "<b>**hi**</b>", avatar_svg: svg, conversation_id: conv } });
  expect(filed.status, filed.text).toBe(202);

  // Then Now lists the description as the same plain text
  const [req] = await identityRequests(owner);
  expect(req!.description).toBe("<b>**hi**</b>");
  expect(req!.conversation).toEqual({ id: conv, title: "Ship search filters" });

  // And the avatar is served from /api/identity-requests/ with a sandboxing CSP and holds no script
  expect(req!.avatar_url).toBe(`/api/identity-requests/${req!.ref}/avatar.svg`);
  const served = await owner.client.get(req!.avatar_url!);
  expect(served.status).toBe(200);
  expect(String(served.headers["content-security-policy"])).toContain("sandbox");
  expect(served.text).not.toContain("script");

  // When the owner approves it
  must(await approveIdentity(owner, req!.ref), "approve", 201);

  // Then "dev-new" is an active participant of conversation 41 and can read the messages before the add
  const token = await lease(srv, box2.key, { as: "dev-new" });
  const seen = must(await send(srv.target, "GET", `/api/conversations/${conv}/messages`, bearer(token)), "read as dev-new").json().messages as { id: number }[];
  expect(seen.some((m) => m.id === before)).toBe(true);

  // And an agent that asks for a conversation the owner is not in is refused when it files
  const devtool = await lease(srv, box2.key, { as: "devtool" });
  const alone = must(await send(srv.target, "POST", "/api/conversations", { json: { client_id: "agent-made-0002", title: "Agents only", participants: [] }, ...bearer(devtool) }), "agent conversation", 201).json().conversation.id as number;
  const refused = await mintSession(srv, box2.key, { as: "dev-other", create: { conversation_id: alone } });
  expect(refused.status).toBe(400);
  expect(refused.json().error.field).toBe("conversation");
});

scenario("With the create_identity scope a conversation join is a request the owner decides", { tag: ["@api"] }, async ({ server }) => {
  // Given "box-2" has the create_identity scope
  const { srv, owner, box2 } = await background(server, { scopes: ["read", "post", "ask", "status", "upload", "create_identity"] });
  const conv = await createConversation(owner, { participants: ["devtool"], title: "Ship search filters" });

  // When "box-2" creates "dev-ci" naming conversation 41
  const res = await mintSession(srv, box2.key, { as: "dev-ci", create: { conversation_id: conv } });

  // Then "dev-ci" exists at once
  expect(res.status, res.text).toBe(201);

  // And conversation 41 lists "dev-ci" as waiting for approval
  const row = must(await owner.client.get(`/api/conversations/${conv}`), "conversation").json().conversation as { participants: { handle: string }[]; pending?: { person: { handle: string } }[] };
  expect(row.participants.map((p) => p.handle)).not.toContain("dev-ci");
  expect((row.pending ?? []).map((p) => p.person.handle)).toContain("dev-ci");
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
