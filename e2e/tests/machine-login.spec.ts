/*
 * S1b CONTRACT: what these bindings (machine-login, sessions, crew and security) expect of the product.
 * It builds on S1a (lib/owner.ts, lib/admin.ts, lib/http.ts) and on design draft 9 §13. Where the S1 plan (§3, §4.4) and this
 * block differ, the block is what the tests assert; the PR summary lists each difference.
 *
 * Letters as in design §13: O owner device cookie, M machine key, L session lease, pub no credential,
 * S single-use step-up sent as header `X-Convoz-Step-Up: <step_up_id>`. Errors are `{"error":{"code","message"[,"field"]}}`.
 *
 * TOKENS  `cvz_m_` machine key, `cvz_s_` lease, `cvz_c_` device code. The testhooks build mints `cvz_<t>_TESTONLY<random>`.
 *         A key hint is the first 10 characters of the key (`cvz_m_TEST`). A key is sent as `Authorization: Bearer <key>`.
 *
 * DEVICE FLOW
 *   POST /api/device/code  pub  {name, host_info:{hostname,os,arch,cli_version}}
 *     -> 200 {device_code, user_code:"XXXX-XXXX" (letters BCDFGHJKLMNPQRSTVWXZ), interval:5, interval_ms:5000, expires_in:600}
 *        name is 1 to 60 of [a-z0-9.-]. 429 too_many_pending when 3 are pending (the message says to deny the waiting requests
 *        in Convoz). 429 rate_limited + Retry-After at 10 per hour or 20 per day per source. Source = TCP peer, or behind the
 *        unix listener the last X-Forwarded-For entry. A request is pending for 10 minutes.
 *   Both device routes carry no cookie and no Authorization header and are exempt from the Origin / X-Convoz check
 *   (a CLI sends neither; there is no ambient authority to forge). S1a's csrf middleware refuses every /api write
 *   without an Authorization header today, so it must skip these two routes.
 *   POST /api/device/token  pub  {device_code}
 *     -> 200 {machine_key, machine_id, machine_name}, repeatable until the first POST /api/sessions made with the key
 *        ("delivered") or 10 minutes after the approval.
 *     -> else 400 with code authorization_pending | slow_down | access_denied | expired_token.
 *        slow_down: a poll less than `interval` (minus 50 ms) after the previous poll. It counts as a poll and adds 5 s to the interval.
 *        access_denied: once, on the first poll after a denial; later polls get expired_token.
 *        An unknown, denied-and-retried, expired or delivered code all get expired_token with a byte-identical body.
 *   GET  /api/machines/requests  O -> {requests:[{id,name,user_code,host_info,source_ip,node_name,created_at,expires_at}]} pending, oldest first
 *        source_ip: peer or forwarded address. node_name: the node `tailscale whois --json <ip>` names (trailing dot removed),
 *        null when whois fails or `--tailscale off`. The Now card shows "Source: <node_name> (<source_ip>)" or "Source: unknown".
 *   GET  /api/now  O -> {machine_requests:[same rows]}
 *   POST /api/machines/requests/:id/approve  O S(machine.approve, target = request id)
 *        {name?, allow:{mode:"list"|"any", identities:[handles], globs:[patterns]}, scopes?:[names], typed_code?}
 *     -> 201 {machine:{id,name,key_hint,scopes,allow}}. Default scopes read, post, ask, status, upload. The extra scopes are
 *        pickup and create_identity. 403 step_up_required (no header). 403 step_up_invalid (used, expired, other action or target).
 *        400 code_mismatch ("The code does not match") when more than one request is pending and typed_code differs.
 *        409 machine_name_taken, 409 machine_cap (10 active). A failed approve leaves the step-up unused.
 *   POST /api/machines/requests/:id/deny and POST /api/machines/requests/deny-all  O (no step-up) -> 200
 *
 * MACHINES
 *   GET   /api/machines  O -> {machines:[{id,name,key_hint,scopes:[names],allow,live_sessions,last_used_at}]} (active machines)
 *   PATCH /api/machines/:id  O S(machine.allow, target = machine id)  {allow} -> 200. Leases of identities that the new
 *         allow-list no longer covers end at once, on that machine only.
 *   POST  /api/machines/:id/reveal      O S(machine.reveal)      -> 200 {machine_key}, Cache-Control: no-store
 *   POST  /api/machines/:id/regenerate  O S(machine.regenerate)  -> 200 {machine_key, key_version}, no-store; old key and its leases end at once
 *   POST  /api/machines/:id/revoke      O S(machine.revoke)      -> 200 {}; its key and leases end at once
 *
 * SESSIONS
 *   POST   /api/sessions  M  {as:handle, client_id (8..64), label (<=80), create?:{display_name}}
 *     -> 201 {lease, session:{id,identity,machine,client_id,label,expires_at}}
 *        403 for an identity the allow-list does not cover, a disabled one, a human, or create without the scope.
 *        429 session_cap at 20 live per identity or 200 live per machine. 429 rate_limited + Retry-After at 30 mints per hour per
 *        identity (300 per machine) and at 5 created identities per day per machine.
 *        Same client_id again for the same identity and machine: the old lease ends (reason "replaced") and the new one works.
 *        An open lease that expired is ended ("expired") first. Two concurrent mints leave exactly one working lease.
 *   GET    /api/me  L -> {identity:{id,handle,display_name,kind:"agent"}, machine:{id,name}, session:{id,client_id,label,expires_at},
 *                         scopes:[names], live_sessions:N}   N = live sessions of that identity on all machines
 *   POST   /api/sessions/renew  L -> 200;  DELETE /api/sessions/me  L -> 204 (ends the lease, reason "logout")
 *   GET    /api/sessions  O -> {sessions:[{id,identity,machine,client_id,label,state:"live"|"ended",end_reason,last_seen_at,expires_at}]}
 *          newest first. NOT in the S1 plan §3.1: Crew -> Sessions needs data, and the CLI and API halves of the Crew scenarios read it here.
 *   A lease lives 12 hours and slides on use (every authenticated call moves the expiry to now + 12 h).
 *   A dead lease (ended, expired, key regenerated, machine revoked, identity disabled, allow-list change) answers 401
 *   {"error":{"code":"session_ended","message":...}}. The disabled case says "The identity was disabled by the owner."
 *   A machine key on any path except POST /api/sessions answers 401 before routing. A lease answers 401 on a route that does not
 *   list L, except POST /api/auth/step-up/options, which answers 403 for it.
 *
 * CREW
 *   POST /api/crew/agents  O S(identity.create)  {handle, display_name} -> 201 {identity:{id,handle,display_name,kind:"agent"}}
 *     handle: 2 to 40 of [a-z0-9-], starts with a letter, not reserved (admin, brief, ...), compared case-insensitively:
 *     a taken handle is 409 handle_taken, an invalid or reserved one is 400 invalid_request with field "handle".
 *     A display name whose Unicode skeleton equals another identity's is 400 invalid_request with field "display_name".
 *   POST /api/identities/:id/disable  O S(identity.disable, target = identity id) -> 200; ends its leases on every machine.
 *   GET  /api/identities (S1a) lists agents with created_by:{kind:"human"|"machine", name}.
 *   No route deletes an identity or changes its kind: DELETE, PATCH and PUT on /api/identities/:id answer 4xx.
 *
 * STEP-UP (S1a routes) actions added: machine.approve, machine.reveal, machine.regenerate, machine.revoke, machine.allow,
 *   identity.create, identity.disable. A passkey added by a recovery code is refused at POST /api/auth/step-up/verify with
 *   403 passkey_too_new ("too new") for 24 hours for machine.approve, machine.reveal, machine.regenerate, machine.revoke and machine.allow (plus S1a's passkey.remove,
 *   recovery.regenerate). A step-up is single use, for one action and target, 5 minutes.
 *
 * AUDIT AND EVENTS  Audit rows (GET /api/admin/audit -> {audit:[{action,target_kind,target_id,...}]}) for machine.approved,
 *   machine.denied, machine.key_revealed, machine.key_regenerated, machine.revoked, machine.allow_changed have target_kind "machine"
 *   and the machine id. Events (table `events`, column `type`): machine.approved, machine.key_revealed (one per reveal, no key in the payload).
 *
 * CLI (the binary under test; HOME is a scratch dir per machine; config dir ~/.config/convoz, or $XDG_CONFIG_HOME/convoz when set)
 *   convoz login --server URL --name N [--store file|keychain|auto]
 *       stdout `Approve "N" in Convoz. Code: XXXX-XXXX`, then after the key arrives `Logged in as machine "N".`, exit 0.
 *       Polls at the server's interval_ms; a lost response is retried with the same device code.
 *       Owner denied: stderr `The owner denied the request.`, exit 3. Expired: stderr `The code expired. Run convoz login again.`, exit 3.
 *       too_many_pending: stderr says to deny the waiting requests in Convoz, exit 5. Never prints a key or a device code.
 *       --store auto uses the OS keychain when one answers, else the file (no DBUS_SESSION_BUS_ADDRESS means none).
 *   convoz login --stdin --server URL --name N [--store ...]   reads the key (one line) from stdin and stores it; no server call.
 *   Credentials file: ~/.config/convoz/credentials, JSON, mode 0600 in a 0700 directory, holds server, machine name and key.
 *       A loose file or directory: exit 3, stderr names the path and the mode it needs ("0600" for the file, "0700" for the directory).
 *   convoz whoami [--sid S | --as H] [--json]
 *       With a session (--sid S, or --as H / CONVOZ_AS=H, which uses or mints the lease for H and the client id): stdout lines
 *         identity: <handle>   machine: <name>   session: <sid>   live sessions: <N>   scopes: <comma-separated names>
 *       Without one: only the local file is read; stdout lines `machine: <name>` and `server: <url>`.
 *   convoz session start --as H [--create --name "Display Name"] [--label L] [--client-id C]
 *       stdout is exactly one line `CONVOZ_SID=<hex, 6 or more>`. Client id: --client-id, else CLAUDE_CODE_SESSION_ID, else random.
 *       The lease is in ~/.config/convoz/sessions/<sid> (JSON {lease,identity,machine,client_id}, mode 0600, directory 0700).
 *   convoz session end --sid S   ends the lease, removes the file, exit 0.
 *   A session file with a mode other than 0600: exit 3, stderr names the file and "0600". A dead lease: exit 3, stderr says the session ended.
 *   An unknown --sid: exit 3. Exit codes: 0 ok, 2 usage, 3 auth, 4 conflict, 5 rate limited, 6 network.
 *
 * ENVIRONMENT  CLI: HOME, XDG_CONFIG_HOME, CONVOZ_AS, CONVOZ_SID, CLAUDE_CODE_SESSION_ID.
 *   Server (testhooks build, CONVOZ_TEST_ADMIN=1): CONVOZ_TEST_POLL_MS=<ms> sets the interval of new device-flow requests
 *   (interval_ms; CLI scenarios use it so a login takes milliseconds; the clock is never frozen, S1 plan amendment 4).
 *   CONVOZ_TEST_PLAINTEXT=1 opens the data file unencrypted (convoz.db in the data dir) for byte scans and probes (S1 plan §4.5).
 *   POST /__test/user-codes {codes:[...]} sets the next user codes. POST /__test/clock {advance_ms} as in S1a.
 *   `--tailscale-bin` points at lib/fake-tailscale.mjs; `whois --json <ip>` answers per test (lib/fake-tailscale.ts: whoisNode).
 *
 * CONSOLE (role and text locators only, so S-U screens must pass the same bindings)
 *   /  heading "Now". Per pending request an article named "<name> wants to connect" with the user code, text "Reported by the machine",
 *      "Source: <node> (<ip>)" or "Source: unknown", buttons "Approve" and "Deny". Button "Deny all" in the page. No requests: text "No machine requests".
 *   Approve opens a dialog named "Approve <name>": textbox "Allowed identities" (comma separated handles and globs, e.g. "devtool, dev-*"),
 *      textbox "Type the code" (only when more than one request is pending), button "Approve". It asks for the passkey by itself.
 *      Errors show in role=alert: "The code does not match"; "The name \"box-2\" is taken. Use Reveal or Regenerate on \"box-2\", or revoke it first."
 *   /crew/machines  heading "Machines"; a listitem per machine with its name and key hint.
 */

import fs from "node:fs";
import { fakeTailscale, whoisNode } from "../lib/fake-tailscale.ts";
import { CliMachine, modeOf } from "../lib/cli.ts";
import { faultProxy } from "../lib/fault-proxy.ts";
import {
  ANY,
  DEFAULT_SCOPES,
  allow,
  approve,
  createAgents,
  freshSource,
  lease,
  loginMachine,
  mintSession,
  nowCard,
  openApproveSheet,
  pendingRequests,
  pollToken,
  requestDeviceCode,
  requestMachine,
  seedUserCodes,
  signInBrowser,
  submitApproveSheet,
} from "../lib/machines.ts";
import { apiServer, bootstrapOwner, must } from "../lib/owner.ts";
import { expect, scenario } from "../lib/scenario.ts";


const POLL = { CONVOZ_TEST_POLL_MS: "250" };
const CODE_LINE = /Approve "([a-z0-9.-]+)" in Convoz\. Code: ([A-Z]{4}-[A-Z]{4})/;
/** A server a CLI and a browser can reach: the tailnet name cannot be dialled, so the name is localhost. */
const localServer = (extra: Record<string, unknown> = {}) => ({ host: "localhost", adminSocket: true, env: POLL, ...extra });

scenario("Login prints a code and Now shows the same code", { tag: ["@cli", "@browser"] }, async ({ server, page, context }) => {
  // Given a fresh server whose fake tailscale names the machine at 127.0.0.1, and a code the test picked
  const ts = fakeTailscale({ whois: { "127.0.0.1": whoisNode("box-2.testonly.ts.net") } });
  const srv = await server(localServer({ tailscale: { bin: ts.bin } }));
  await seedUserCodes(srv, ["KQWD-MZTP"]);
  const owner = await bootstrapOwner(srv);

  // When "convoz login --name box-2" runs on the machine
  const login = new CliMachine().startLogin(srv.origin, "box-2");

  // Then the CLI prints 'Approve "box-2" in Convoz. Code: KQWD-MZTP'
  const line = await login.waitForStdout(CODE_LINE);
  expect(line[0]).toBe('Approve "box-2" in Convoz. Code: KQWD-MZTP');

  // And the owner sees a Now card "box-2 wants to connect" with the code "KQWD-MZTP"
  await signInBrowser(srv, owner, page, context);
  const card = nowCard(page, "box-2");
  await expect(card).toBeVisible();
  await expect(card).toContainText("KQWD-MZTP");

  // And the card labels the host info "reported by the machine"
  await expect(card).toContainText(/reported by the machine/i);

  // And the card shows the address and the tailnet name of the machine that asked, or "unknown" when Tailscale cannot name it
  await expect(card).toContainText("Source: box-2.testonly.ts.net (127.0.0.1)");
  expect(ts.calls().some((c) => c.includes("whois") && c.includes("--json") && c.some((a) => a.startsWith("127.0.0.1")))).toBe(true);
  ts.set({});
  must(await requestDeviceCode(srv, "box-3"), "second request");
  await page.reload();
  await expect(nowCard(page, "box-3")).toContainText(/Source:\s*unknown/);

  // The waiting CLI ends when the owner denies everything
  must(await owner.client.post("/api/machines/requests/deny-all"), "deny all");
  expect((await login.done).code).toBe(3);
});

scenario("A poll faster than the interval is told to slow down", { tag: ["@api"] }, async ({ server, testApi }) => {
  // Given "convoz login --name box-2" is waiting for approval (its request exists)
  const srv = await server(apiServer());
  const clock = testApi(srv);
  const dc = must(await requestDeviceCode(srv, "box-2"), "device code").json();
  expect(dc.interval).toBe(5);

  // When the machine polls the token route twice within 2 seconds (the first poll comes after the interval)
  await clock.advanceClock(5_100);
  const first = await pollToken(srv, dc.device_code);
  expect(first.json().error.code).toBe("authorization_pending");
  const second = await pollToken(srv, dc.device_code);

  // Then the second answer is "slow_down"
  expect(second.status).toBe(400);
  expect(second.json().error.code).toBe("slow_down");

  // And a poll 5 seconds later is again "slow_down" because the interval grew to 10 seconds
  await clock.advanceClock(5_000);
  const third = await pollToken(srv, dc.device_code);
  expect(third.json().error.code).toBe("slow_down");

  // Control: after waiting out the grown interval the poll is accepted again
  await clock.advanceClock(30_000);
  expect((await pollToken(srv, dc.device_code)).json().error.code).toBe("authorization_pending");
});

scenario("Approval creates the machine with its allow-list and scopes", { tag: ["@browser", "@api"] }, async ({ server, page, context }) => {
  // Given a pending machine request "box-2" (agents "devtool" and "dev-search" exist)
  const srv = await server({ host: "localhost", adminSocket: true });
  const owner = await bootstrapOwner(srv);
  await createAgents(owner, "devtool", "dev-search");
  const req = await requestMachine(srv, owner, "box-2");

  // When the owner approves it with allow-list "devtool" and "dev-*" and the default scopes
  await signInBrowser(srv, owner, page, context);
  const sheet = await openApproveSheet(page, "box-2");
  await submitApproveSheet(sheet, { allowed: "devtool, dev-*" });
  await expect(sheet).toBeHidden();

  // Then Crew → Machines lists "box-2" with a key hint that starts with "cvz_m_"
  await page.goto(`${srv.origin}/crew/machines`);
  await expect(page.getByRole("heading", { name: "Machines", exact: true })).toBeVisible();
  await expect(page.getByRole("listitem").filter({ hasText: "box-2" })).toContainText("cvz_m_");
  const machines = must(await owner.client.get("/api/machines"), "list machines").json().machines;
  expect(machines).toHaveLength(1);
  expect(machines[0].key_hint.startsWith("cvz_m_")).toBe(true);

  // And its scopes are read, post, ask, status and upload, without pickup or create_identity
  expect(machines[0].scopes).toEqual(DEFAULT_SCOPES);
  expect(machines[0].allow).toEqual(allow("devtool", "dev-*"));

  // And the owner's audit view lists "machine approved · box-2" (the audit rows name the machine)
  const audit = must(await owner.client.get("/api/admin/audit"), "audit").json().audit as { action: string; target_kind: string; target_id: number }[];
  expect(audit.some((r) => r.action === "machine.approved" && r.target_kind === "machine" && r.target_id === machines[0].id)).toBe(true);

  // And the machine can fetch its key (API half)
  const tok = await pollToken(srv, req.deviceCode);
  expect(tok.status).toBe(200);
  expect(tok.json().machine_key.startsWith("cvz_m_")).toBe(true);
});

scenario("The owner must type the code when more than one request is pending", { tag: ["@browser"] }, async ({ server, page, context }) => {
  // Given pending machine requests "box-2" with code "KQWD-MZTP" and "box-9" with code "PLRT-HXCV"
  const srv = await server({ host: "localhost", adminSocket: true });
  await seedUserCodes(srv, ["KQWD-MZTP", "PLRT-HXCV"]);
  const owner = await bootstrapOwner(srv);
  await requestMachine(srv, owner, "box-2");
  await requestMachine(srv, owner, "box-9");

  // When the owner opens the approve sheet for "box-2"
  await signInBrowser(srv, owner, page, context);
  const sheet = await openApproveSheet(page, "box-2");

  // Then the sheet asks the owner to type the code
  await expect(sheet.getByRole("textbox", { name: "Type the code" })).toBeVisible();

  // And approving with the typed code "PLRT-HXCV" shows "The code does not match"
  await submitApproveSheet(sheet, { allowed: "devtool", typedCode: "PLRT-HXCV" });
  await expect(page.getByRole("alert")).toContainText("The code does not match");
  expect(must(await owner.client.get("/api/machines"), "list machines").json().machines).toEqual([]);
});

scenario("A denied request creates no machine", { tag: ["@cli"] }, async ({ server }) => {
  // Given "convoz login --name box-2" is waiting for approval
  const srv = await server(localServer());
  const owner = await bootstrapOwner(srv);
  const login = new CliMachine().startLogin(srv.origin, "box-2");
  await login.waitForStdout(CODE_LINE);

  // When the owner denies the request
  const [req] = await pendingRequests(owner);
  must(await owner.client.post(`/api/machines/requests/${req!.id}/deny`), "deny");

  // Then the CLI exits 3 with a message that the owner denied the request
  const res = await login.done;
  expect(res.code, res.stderr).toBe(3);
  expect(res.stderr).toMatch(/owner denied the request/i);

  // And Crew → Machines does not list "box-2"
  expect(must(await owner.client.get("/api/machines"), "list machines").json().machines).toEqual([]);
});

scenario("An unapproved request expires after 10 minutes", { tag: ["@cli"] }, async ({ server, testApi }) => {
  // Given "convoz login --name box-2" is waiting for approval
  const srv = await server(localServer());
  const owner = await bootstrapOwner(srv);
  const login = new CliMachine().startLogin(srv.origin, "box-2");
  await login.waitForStdout(CODE_LINE);

  // When the test clock moves forward 10 minutes and 1 second (the real clock keeps running, so the CLI keeps polling)
  await testApi(srv).advanceClock(10 * 60_000 + 1_000);

  // Then the CLI exits 3 with a message that the code expired
  const res = await login.done;
  expect(res.code, res.stderr).toBe(3);
  expect(res.stderr).toMatch(/code expired/i);

  // And Now no longer shows the request
  expect(must(await owner.client.get("/api/now"), "now").json().machine_requests).toEqual([]);
});

scenario("Bad device codes all get the same error", { tag: ["@api"] }, async ({ server, testApi }) => {
  const srv = await server(apiServer());
  const clock = testApi(srv);
  const owner = await bootstrapOwner(srv);
  await createAgents(owner, "devtool");
  // Every poll is a full interval after the one before, so only the code decides the answer.
  const poll = async (code: string) => {
    await clock.advanceClock(5_100);
    return pollToken(srv, code);
  };
  const bodies: string[] = [];

  // Case: unknown to the server
  const unknown = await poll("cvz_c_TESTONLY0000000000000000000000000000");
  expect(unknown.status).toBe(400);
  bodies.push(unknown.text);

  // Case: denied by the owner and then retried (the first poll after the denial says so, once)
  const denied = await requestMachine(srv, owner, "box-7");
  must(await owner.client.post(`/api/machines/requests/${denied.requestId}/deny`), "deny");
  expect((await poll(denied.deviceCode)).json().error.code).toBe("access_denied");
  bodies.push((await poll(denied.deviceCode)).text);

  // Case: for a key that a request already used
  const used = await loginMachine(srv, owner, "box-8");
  must(await mintSession(srv, used.key, { as: "devtool" }), "first use of the key", 201);
  bodies.push((await poll(used.deviceCode)).text);

  // Case: past its 10-minute expiry
  const late = await requestMachine(srv, owner, "box-9");
  await clock.advanceClock(10 * 60_000 + 1_000);
  bodies.push((await poll(late.deviceCode)).text);

  // Then the answer is "expired_token" with the same body as every other bad code
  expect(JSON.parse(bodies[0]!).error.code).toBe("expired_token");
  expect(bodies.every((b) => b === bodies[0])).toBe(true);
});

scenario("A lost token response is recovered with the same device code", { tag: ["@cli", "@api"] }, async ({ server }) => {
  // Given the CLI logs in through a fault proxy that drops the response of the first successful token poll
  const srv = await server(localServer());
  const owner = await bootstrapOwner(srv);
  const proxy = await faultProxy(srv.target, { method: "POST", path: "/api/device/token", nth: 1 });
  const box = new CliMachine();
  const login = box.startLogin(proxy.url, "box-2");
  await login.waitForStdout(CODE_LINE);

  // And the owner approved the machine request "box-2"
  const [req] = await pendingRequests(owner);
  must(await approve(owner, req!.id, { allow: ANY }), "approve", 201);

  // When the CLI polls again with the same device code
  const res = await login.done;

  // Then the CLI receives a key and "convoz whoami" names the machine "box-2"
  expect(res.code, res.stderr).toBe(0);
  const who = await box.whoami();
  expect(who.stdout).toContain("machine: box-2");

  // And the proxy log shows two token polls with the same device code
  const polls = proxy.entries("POST", "/api/device/token");
  const answered = polls.filter((e) => e.status === 200);
  expect(answered).toHaveLength(2);
  expect(answered[0]!.dropped).toBe(true);
  expect(new Set(polls.map((e) => e.bodyHash)).size).toBe(1);
  await proxy.close();
});

scenario("The key is stored in a private file and never printed", { tag: ["@cli"] }, async ({ server }) => {
  const srv = await server(localServer());
  const owner = await bootstrapOwner(srv);
  const box = new CliMachine();

  // When "convoz login --name box-2 --store file" completes
  const login = box.startLogin(srv.origin, "box-2", ["--store", "file"]);
  await login.waitForStdout(CODE_LINE);
  const [req] = await pendingRequests(owner);
  must(await approve(owner, req!.id, { allow: ANY }), "approve", 201);
  const res = await login.done;
  expect(res.code, res.stderr).toBe(0);

  // Then "~/.config/convoz/credentials" has mode 0600 in a directory with mode 0700
  expect(modeOf(box.credentialsPath)).toBe(0o600);
  expect(modeOf(box.configDir)).toBe(0o700);
  expect(fs.readFileSync(box.credentialsPath, "utf8")).toContain("cvz_m_");

  // And stdout and stderr of the CLI contain no "cvz_m_" and no "cvz_c_" string
  const out = res.stdout + res.stderr;
  expect(out).not.toContain("cvz_m_");
  expect(out).not.toContain("cvz_c_");
});

scenario("The CLI refuses a credentials file with loose permissions", { tag: ["@cli"] }, async ({ server }) => {
  const srv = await server(localServer());
  const owner = await bootstrapOwner(srv);
  const key = (await loginMachine(srv, owner, "box-2")).key;
  const box = new CliMachine();
  expect((await box.install(srv.origin, "box-2", key)).code).toBe(0);
  expect((await box.whoami()).code).toBe(0);

  // Given the credentials file has mode <file mode> in a directory with mode <dir mode>; When "convoz whoami" runs
  const rows: [number, number][] = [
    [0o644, 0o700],
    [0o640, 0o700],
    [0o600, 0o755],
  ];
  const seen: { code: number | null; names: boolean }[] = [];
  for (const [fileMode, dirMode] of rows) {
    fs.chmodSync(box.configDir, dirMode);
    fs.chmodSync(box.credentialsPath, fileMode);
    const res = await box.whoami();
    // the message names the path and the mode it needs
    const [path, need] = fileMode !== 0o600 ? [box.credentialsPath, "0600"] : [box.configDir, "0700"];
    seen.push({ code: res.code, names: res.stderr.includes(path) && res.stderr.includes(need) });
    fs.chmodSync(box.configDir, 0o700);
    fs.chmodSync(box.credentialsPath, 0o600);
  }

  // Then the CLI exits 3, and the message names the path and the mode it needs
  expect(seen).toEqual(rows.map(() => ({ code: 3, names: true })));
});

scenario("Headless Linux falls back to the file store", { tag: ["@cli"] }, async ({ server }) => {
  // Given the machine has no OS keychain service (the CLI's environment has no session bus)
  const srv = await server(localServer());
  const owner = await bootstrapOwner(srv);
  const box = new CliMachine();
  expect(box.env().DBUS_SESSION_BUS_ADDRESS).toBeUndefined();

  // When "convoz login --name box-2 --store auto" completes
  const login = box.startLogin(srv.origin, "box-2", ["--store", "auto"]);
  await login.waitForStdout(CODE_LINE);
  const [req] = await pendingRequests(owner);
  must(await approve(owner, req!.id, { allow: ANY }), "approve", 201);
  const res = await login.done;
  expect(res.code, res.stderr).toBe(0);

  // Then the key is in the credentials file with mode 0600
  expect(modeOf(box.credentialsPath)).toBe(0o600);
  expect(fs.readFileSync(box.credentialsPath, "utf8")).toContain("cvz_m_");

  // And "convoz whoami" works
  const who = await box.whoami();
  expect(who.code, who.stderr).toBe(0);
  expect(who.stdout).toContain("machine: box-2");
});

scenario("Machine names are unique while active", { tag: ["@browser"] }, async ({ server, page, context }) => {
  // Given an active machine "box-2"
  const srv = await server({ host: "localhost", adminSocket: true });
  const owner = await bootstrapOwner(srv);
  await loginMachine(srv, owner, "box-2");

  // When the owner tries to approve a new request named "box-2" as a new machine
  await requestMachine(srv, owner, "box-2");
  await signInBrowser(srv, owner, page, context);
  const sheet = await openApproveSheet(page, "box-2");
  await submitApproveSheet(sheet, { allowed: "devtool" });

  // Then the sheet says the name is taken
  const alert = page.getByRole("alert");
  await expect(alert).toContainText(/is taken/i);

  // And it says to use Reveal or Regenerate on "box-2", or to revoke it first
  await expect(alert).toContainText(/Reveal or Regenerate on "box-2", or revoke it first/);
});

scenario("The owner denies every pending request at once", { tag: ["@browser", "@cli"] }, async ({ server, page, context }) => {
  // Given 3 machine requests are pending and the owner knows none of them
  const srv = await server(localServer());
  const owner = await bootstrapOwner(srv);
  const logins = ["box-a", "box-b", "box-c"].map((name) => new CliMachine().startLogin(srv.origin, name));
  for (const l of logins) await l.waitForStdout(CODE_LINE);

  // When the owner taps "Deny all" in Now
  await signInBrowser(srv, owner, page, context);
  await expect(page.getByRole("article")).toHaveCount(3);
  await page.getByRole("button", { name: "Deny all", exact: true }).click();

  // Then Now shows no machine request
  await expect(page.getByRole("article")).toHaveCount(0);
  await expect(page.getByText("No machine requests")).toBeVisible();

  // And each waiting "convoz login" exits 3 with a message that the owner denied the request
  const results = await Promise.all(logins.map((l) => l.done));
  expect(results.map((r) => r.code)).toEqual([3, 3, 3]);
  expect(results.every((r) => /owner denied the request/i.test(r.stderr))).toBe(true);
});

// ---- contracts -------------------------------------------------------------------------------------

scenario("The token poll waits while the request is pending", { tag: ["@api"] }, async ({ server, testApi }) => {
  // Given "convoz login --name box-2" is waiting for approval
  const srv = await server(apiServer());
  const owner = await bootstrapOwner(srv);
  const dc = must(await requestDeviceCode(srv, "box-2"), "device code").json();

  // When the machine polls POST /api/device/token after 5 seconds
  await testApi(srv).advanceClock(5_100);
  const res = await pollToken(srv, dc.device_code);

  // Then the answer is "authorization_pending"
  expect(res.status).toBe(400);
  expect(res.json().error.code).toBe("authorization_pending");

  // And GET /api/machines does not list "box-2"
  expect(must(await owner.client.get("/api/machines"), "list machines").json().machines).toEqual([]);
});

scenario("Approval without a single-use step-up is refused", { tag: ["@api"] }, async ({ server }) => {
  // Given a pending machine request "box-2"
  const srv = await server(apiServer());
  const owner = await bootstrapOwner(srv);
  const req = await requestMachine(srv, owner, "box-2");

  // When the owner approves it with no X-Convoz-Step-Up header
  const res = await owner.client.post(`/api/machines/requests/${req.requestId}/approve`, { allow: ANY });

  // Then the server answers 403
  expect(res.status).toBe(403);
  expect(res.json().error.code).toBe("step_up_required");

  // And GET /api/machines does not list "box-2"
  expect(must(await owner.client.get("/api/machines"), "list machines").json().machines).toEqual([]);
});

scenario("The first request made with the key marks it delivered", { tag: ["@api"] }, async ({ server, testApi }) => {
  const srv = await server(apiServer());
  const clock = testApi(srv);
  const owner = await bootstrapOwner(srv);
  await createAgents(owner, "devtool");

  // Given the machine "box-2" fetched its key (and can fetch it again until it is used)
  const box = await loginMachine(srv, owner, "box-2");
  await clock.advanceClock(5_100);
  const again = await pollToken(srv, box.deviceCode);
  expect(again.status).toBe(200);
  expect(again.json().machine_key).toBe(box.key);

  // When the machine mints a session lease with that key
  must(await mintSession(srv, box.key, { as: "devtool" }), "mint", 201);

  // Then a later token poll with the same device code answers "expired_token"
  await clock.advanceClock(5_100);
  const later = await pollToken(srv, box.deviceCode);
  expect(later.status).toBe(400);
  expect(later.json().error.code).toBe("expired_token");
});

scenario("An approved key cannot be fetched after the request expires", { tag: ["@api"] }, async ({ server, testApi }) => {
  // Given the owner approved the machine request "box-2", and the machine never fetched the key
  const srv = await server(apiServer());
  const owner = await bootstrapOwner(srv);
  const req = await requestMachine(srv, owner, "box-2");
  must(await approve(owner, req.requestId, { allow: ANY }), "approve", 201);

  // When the test clock moves 10 minutes and 1 second past the approval
  await testApi(srv).advanceClock(10 * 60_000 + 1_000);

  // Then a token poll with the device code answers "expired_token"
  const res = await pollToken(srv, req.deviceCode);
  expect(res.status).toBe(400);
  expect(res.json().error.code).toBe("expired_token");
});

scenario("A fourth pending request is refused", { tag: ["@api"] }, async ({ server }) => {
  // Given 3 machine requests are pending
  const srv = await server(apiServer());
  const owner = await bootstrapOwner(srv);
  for (const name of ["box-1", "box-2", "box-3"]) must(await requestDeviceCode(srv, name), `request ${name}`);

  // When a fourth machine starts "convoz login --name box-4"
  const res = await requestDeviceCode(srv, "box-4");

  // Then the server answers 429 with the code "too_many_pending"
  expect(res.status).toBe(429);
  expect(res.json().error.code).toBe("too_many_pending");

  // And the CLI says to deny the waiting requests in Convoz (the message it prints)
  expect(res.json().error.message).toMatch(/deny the waiting requests in Convoz/i);

  // And Now still shows 3 machine requests
  expect(must(await owner.client.get("/api/now"), "now").json().machine_requests).toHaveLength(3);
});

scenario("One source is limited to 10 requests per hour", { tag: ["@api"] }, async ({ server }) => {
  // Given one source started 10 device-flow requests in the last hour (each denied, so none is pending)
  const srv = await server(apiServer());
  const owner = await bootstrapOwner(srv);
  for (let i = 1; i <= 10; i++) {
    must(await requestDeviceCode(srv, `box-${i}`), `request ${i}`);
    must(await owner.client.post("/api/machines/requests/deny-all"), "deny all");
  }

  // When it starts an eleventh
  const res = await requestDeviceCode(srv, "box-11");

  // Then the server answers 429 with a Retry-After header
  expect(res.status).toBe(429);
  expect(res.json().error.code).toBe("rate_limited");
  expect(Number(res.headers["retry-after"])).toBeGreaterThan(0);
});

scenario("At most 10 machines are active", { tag: ["@api"] }, async ({ server }) => {
  // Given 10 active machines (on the unix listener, each login from its own source address, so no per-source limit gets in the way)
  const srv = await server(apiServer({ listen: "unix" }));
  const owner = await bootstrapOwner(srv);
  for (let i = 1; i <= 10; i++) await loginMachine(srv, owner, `box-${i}`);

  // When the owner approves an eleventh machine
  const req = await requestMachine(srv, owner, "box-11", freshSource());
  const res = await approve(owner, req.requestId, { allow: ANY });

  // Then the server answers 409 with the code "machine_cap"
  expect(res.status).toBe(409);
  expect(res.json().error.code).toBe("machine_cap");
});

scenario("A request cannot take an active machine's name", { tag: ["@api"] }, async ({ server }) => {
  // Given an active machine "box-2"
  const srv = await server(apiServer());
  const owner = await bootstrapOwner(srv);
  await createAgents(owner, "devtool");
  const active = await loginMachine(srv, owner, "box-2", allow("devtool"));

  // When the owner approves a new request named "box-2"
  const req = await requestMachine(srv, owner, "box-2");
  const res = await approve(owner, req.requestId, { allow: ANY });

  // Then the server answers 409 with the code "machine_name_taken"
  expect(res.status).toBe(409);
  expect(res.json().error.code).toBe("machine_name_taken");

  // And the key of the active "box-2" still works
  expect((await mintSession(srv, active.key, { as: "devtool" })).status).toBe(201);
  expect(await lease(srv, active.key, { as: "devtool" })).toMatch(/^cvz_s_/);
});
