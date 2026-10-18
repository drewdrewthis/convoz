import { CliMachine, installedMachine } from "../lib/cli.ts";
import { agentPort, agentServer, auditActions, INVITE_RE, makeInvite, openInvites, ownerInvite, startLoginViaAgent, viaAgent } from "../lib/agent-port.ts";
import { convoz, createConversation, startSession } from "../lib/chat.ts";
import { clientId, createAgents, dataFileBytes, countOf, plainDb, pendingRequests, approve, allow, signInBrowser, loginMachine, mintSession, identityRequests, requestDeviceCode, HOUR } from "../lib/machines.ts";
import { send } from "../lib/http.ts";
import { bootstrapOwner, must, tmpDir } from "../lib/owner.ts";
import { expect, scenario } from "../lib/scenario.ts";

/*
 * agent-port.feature (the agents-only listener). Contract: docs/design.md "The agents-only address".
 *   serve --agent-listen 127.0.0.1:PORT --agent-host NAME[:PORT]: a second listener, off unless both flags are given. The ready file
 *   carries "agent": "tcp://127.0.0.1:PORT". It serves the route-table rows that carry Agent, Lease or a machine key, and answers
 *   404 {"error":{"code":"not_found"}} to every other path, whatever the cookie. A Host that is not the agent name is 421.
 *   Per client address: 10 login starts an hour, 60 polls a minute, 30 answers of 401 in 10 minutes (then 429 + Retry-After).
 *   The client address is the peer, or the last X-Forwarded-For entry when the peer is loopback (the local Funnel proxy).
 *   GET /api/machines/requests rows carry via_internet (true when the request came in on the agent listener).
 *   GET /api/version carries agent_url when the listener is on. /install on the agent listener names the agent origin.
 *   An internet request needs an invite (owner ruling 2026-10-18; docs/design.md 3.4a): POST /api/invites (owner or an approved agent's lease)
 *   {conversation_id?, note?} -> 201 {invite:{id, hint, maker, maker_is_owner, token, server, login, ...}}; GET /api/invites; DELETE /api/invites/:id.
 *   POST /api/device/code {invite} and POST /api/sessions {create:{invite}} on the agent listener spend it; without a usable one the answer
 *   looks accepted and nothing is made. The cards (GET /api/now, GET /api/machines/requests) carry invite {by, by_owner, note} or null.
 *   Audit actions: invite.created, invite.used, invite.revoked, invite.expired.
 */

const AGENT_LINE = /Approve "([a-z0-9.-]+)" as @([a-z0-9-]+) in Convoz\. Code: ([A-Z]{4}-[A-Z]{4})/;

scenario("An agent outside the tailnet connects with one tap", { tag: ["@cli", "@browser"] }, async ({ server, page, context }) => {
  // Given a Convoz server with an agents-only address
  const srv = await server(agentServer());
  const agent = agentPort(srv);
  const owner = await bootstrapOwner(srv);
  const invite = await ownerInvite(owner);

  // When "convoz login --name dot-box --as dot" runs against the agents-only address
  const box = new CliMachine();
  const login = box.startLogin(agent.origin, "dot-box", ["--as", "dot", "--invite", invite]);

  // Then the CLI prints 'Approve "dot-box" as @dot in Convoz.' with the code
  const line = await login.waitForStdout(AGENT_LINE);
  expect(line[0]).toMatch(/^Approve "dot-box" as @dot in Convoz\. Code: [A-Z]{4}-[A-Z]{4}$/);

  // And the owner sees one Now card "dot-box wants to connect as @dot"
  await signInBrowser(srv, owner, page, context);
  await expect(page.getByRole("article")).toHaveCount(1);
  const card = page.getByRole("article", { name: "dot-box wants to connect as @dot", exact: true });
  await expect(card).toBeVisible();

  // And the card says the request came "via internet"
  await expect(card).toContainText("via internet");

  // When the owner taps Approve on that card
  await card.getByRole("button", { name: "Approve", exact: true }).click();

  // Then the CLI logs in as machine "dot-box"
  const done = await login.done;
  expect(done.code, done.stderr).toBe(0);
  expect(done.stdout).toContain('Logged in as machine "dot-box".');

  // And "convoz session start --as dot" works on "dot-box" against the same address
  const session = await box.sessionStart("dot");
  expect(session.code, session.stderr).toBe(0);
});

scenario("The invite prompt shows the agents-only address", { tag: ["@browser"] }, async ({ server, page, context }) => {
  // Given a Convoz server with an agents-only address
  const srv = await server(agentServer());
  const agent = agentPort(srv);
  const owner = await bootstrapOwner(srv);
  await signInBrowser(srv, owner, page, context);

  // When the owner opens the invite sheet in Crew
  await page.goto(`${srv.origin}/crew`);
  await page.getByRole("button", { name: /^(Add|Invite) agent$/ }).first().click();

  // Then the prompt names the agents-only address as the server
  const prompt = page.getByRole("dialog", { name: "Invite agent" }).getByLabel("Connect prompt");
  await expect(prompt).toContainText(`Server:  ${agent.origin}`);
  await expect(prompt).toContainText(`curl -fsSL ${agent.origin}/install | sh`);

  // And the prompt does not name the tailnet address
  await expect(prompt).not.toContainText(new RegExp(`${srv.origin.replace(/[.]/g, "\\.")}(?!\\d)`));
});

scenario("An owner route gives 404 on the agents-only port even with the owner's cookie", { tag: ["@api"] }, async ({ server }) => {
  // Given a Convoz server with an agents-only address and owner "drew" signed in
  const srv = await server(agentServer());
  const owner = await bootstrapOwner(srv);
  const cookie = owner.client.cookieHeader();
  expect(cookie).not.toBe("");

  // When the owner's cookie is sent to owner routes, pages, push, settings, admin and test routes on the agents-only port
  const refused: [string, string][] = [
    ["GET", "/api/machines/requests"], ["GET", "/api/machines"], ["POST", "/api/machines/requests/1/approve"],
    ["POST", "/api/machines/requests/deny-all"], ["POST", "/api/identity-requests/idr_x/approve"], ["POST", "/api/crew/agents"],
    ["GET", "/api/identities"], ["GET", "/api/settings"], ["PATCH", "/api/settings"], ["GET", "/api/push/vapid-key"],
    ["GET", "/api/stream"], ["GET", "/api/sessions"], ["POST", "/api/auth/passkey/login/options"], ["POST", "/api/auth/recovery"],
    ["GET", "/api/admin/audit"], ["GET", "/__test/routes"], ["GET", "/"], ["GET", "/signin"], ["GET", "/chats"], ["GET", "/crew"],
    ["GET", "/assets/app.js"], ["GET", "/manifest.webmanifest"], ["GET", "/sw.js"],
  ];
  const answers = [];
  for (const [method, path] of refused) answers.push({ path, res: await viaAgent(srv, method, path, { cookie, csrf: true }) });

  // Then every one of them answers 404
  for (const { path, res } of answers) expect(res.status, path).toBe(404);

  // And the same cookie still works on the owner's port
  expect((await owner.client.get("/api/machines")).status).toBe(200);

  // And GET /api/me on the agents-only port with the cookie answers 401
  expect((await viaAgent(srv, "GET", "/api/me", { cookie })).status).toBe(401);
});

scenario("A request for a host name that is not the agents-only name is refused", { tag: ["@api"] }, async ({ server }) => {
  // Given a Convoz server with an agents-only address
  const srv = await server(agentServer());

  // When GET /healthz arrives with the Host of the owner's name
  const res = await viaAgent(srv, "GET", "/healthz", { hostHeader: "convoz.testonly.ts.net" });

  // Then the server answers 421
  expect(res.status).toBe(421);
});

scenario("Login, approval and a lease work through the agents-only port", { tag: ["@api"] }, async ({ server }) => {
  // Given a Convoz server with an agents-only address and owner "drew" signed in, and an agent identity "dot"
  const srv = await server(agentServer());
  const owner = await bootstrapOwner(srv);
  await createAgents(owner, "dot");

  // When a machine starts the device login on the agents-only port from the internet address 203.0.113.9
  const started = must(await startLoginViaAgent(srv, "dot-box", "203.0.113.9"), "device code via the agent port").json();

  // Then the owner's list of requests shows source 203.0.113.9 with via_internet true
  const [req] = await pendingRequests(owner);
  expect(req?.source_ip).toBe("203.0.113.9");
  expect(req?.via_internet).toBe(true);

  // When the owner approves it on the owner's port
  must(await approve(owner, req!.id, { allow: allow("dot") }), "approve", 201);

  // And the machine polls the token on the agents-only port and mints a session
  const token = must(await viaAgent(srv, "POST", "/api/device/token", { from: "203.0.113.9", json: { device_code: started.device_code } }), "token via the agent port").json();
  const minted = must(await viaAgent(srv, "POST", "/api/sessions", { bearer: token.machine_key, json: { as: "dot", client_id: clientId() } }), "mint via the agent port", 201).json();

  // Then GET /api/me with the lease on the agents-only port answers the identity "dot"
  const me = must(await viaAgent(srv, "GET", "/api/me", { bearer: minted.lease }), "me via the agent port").json();
  expect(me.identity.handle).toBe("dot");

  // And the server log names the client address 203.0.113.9 and no cookie or credential
  expect(srv.log()).toContain("ip=203.0.113.9");
  expect(srv.log()).not.toContain(minted.lease);
  expect(srv.log()).not.toContain(token.machine_key);
});

scenario("The install script and the version name the agents-only address", { tag: ["@api"] }, async ({ server }) => {
  // Given a Convoz server with an agents-only address
  const srv = await server(agentServer());
  const agent = agentPort(srv);

  // When /install and /api/version are fetched on both ports
  const viaAgentScript = must(await viaAgent(srv, "GET", "/install"), "install via the agent port").text;
  const viaOwnerScript = must(await send(srv.target, "GET", "/install"), "install via the owner port").text;
  const agentVersion = must(await viaAgent(srv, "GET", "/api/version"), "version via the agent port").json();
  const ownerVersion = must(await send(srv.target, "GET", "/api/version"), "version via the owner port").json();

  // Then the script from the agents-only port names the agents-only address and not the owner's
  expect(viaAgentScript).toContain(`SERVER='${agent.origin}'`);
  expect(viaOwnerScript).toContain(`SERVER='${srv.origin}'`);
  expect(viaAgentScript).not.toContain(`SERVER='${srv.origin}'`);

  // And /api/version carries agent_url on both ports
  expect(agentVersion.agent_url).toBe(agent.origin);
  expect(ownerVersion.agent_url).toBe(agent.origin);

  // And the version on the agents-only port is a short commit, with no "+dirty" mark
  expect(agentVersion.version).not.toContain("+");

  // And a server with no agents-only address carries no agent_url
  const plain = await server({ host: "localhost", dataDir: tmpDir("convoz-plain-") });
  expect(must(await send(plain.target, "GET", "/api/version"), "version of a plain server").json().agent_url).toBeUndefined();
});

scenario("Login starts are limited per internet address", { tag: ["@api"] }, async ({ server }) => {
  // Given a Convoz server with an agents-only address and owner "drew" signed in
  const srv = await server(agentServer());
  const owner = await bootstrapOwner(srv);

  // When one address starts the device login 10 times, the owner denying each
  for (let i = 1; i <= 10; i++) {
    must(await startLoginViaAgent(srv, `box-${i}`, "203.0.113.20"), `start ${i}`);
    must(await owner.client.post("/api/machines/requests/deny-all"), "deny all");
  }

  // Then the 11th start answers 429 with a Retry-After
  const eleventh = await startLoginViaAgent(srv, "box-11", "203.0.113.20");
  expect(eleventh.status).toBe(429);
  expect(Number(eleventh.headers["retry-after"])).toBeGreaterThan(0);

  // And another address can still start
  expect((await startLoginViaAgent(srv, "box-12", "203.0.113.21")).status).toBe(200);
});

scenario("Failed credentials are limited per internet address", { tag: ["@api"] }, async ({ server }) => {
  // Given a Convoz server with an agents-only address
  const srv = await server(agentServer());
  const bad = "cvz_s_TESTONLYnotalease";

  // When one address sends 30 requests with a bad credential
  const first = [];
  for (let i = 0; i < 30; i++) first.push((await viaAgent(srv, "GET", "/api/me", { from: "203.0.113.30", bearer: bad })).status);

  // Then they answer 401
  expect(first.every((s) => s === 401)).toBe(true);

  // And its next request answers 429
  const next = await viaAgent(srv, "GET", "/api/me", { from: "203.0.113.30", bearer: bad });
  expect(next.status).toBe(429);
  expect(Number(next.headers["retry-after"])).toBeGreaterThan(0);

  // And another address still answers 401
  expect((await viaAgent(srv, "GET", "/api/me", { from: "203.0.113.31", bearer: bad })).status).toBe(401);
});

scenario("One agent flag without the other is a usage error", { tag: ["@cli"] }, async ({ serveCli }) => {
  // When "convoz serve" starts with --agent-listen and no --agent-host
  const alone = await serveCli({ host: "localhost", extraArgs: ["--agent-listen", "127.0.0.1:0"] });

  // Then it exits with code 2
  expect(alone.code, alone.stderr).toBe(2);

  // And a non-loopback --agent-listen is refused with the wall's code 13
  const open = await serveCli({ host: "localhost", extraArgs: ["--agent-listen", "0.0.0.0:0", "--agent-host", "dot.testonly.ts.net"] });
  expect(open.code, open.stderr).toBe(13);
});

scenario("A request that is not from the Funnel proxy is refused with 400", { tag: ["@api"] }, async ({ server }) => {
  // Given a Convoz server with an agents-only address that knows a client only by the Funnel proxy
  const srv = await server(agentServer({ strict: true }));
  const agent = agentPort(srv);

  // When a request arrives with no Funnel marker, and another with a forged X-Forwarded-For and no marker
  const bare = await send(agent.target, "GET", "/healthz");
  const forged = await send(agent.target, "GET", "/healthz", { headers: { "X-Forwarded-For": "203.0.113.9" } });

  // Then both answer 400 and neither is served
  expect(bare.status).toBe(400);
  expect(forged.status).toBe(400);

  // And a request with the marker and a client address is served
  expect((await viaAgent(srv, "GET", "/healthz", { from: "203.0.113.9" })).status).toBe(200);

  // And the log has no line that names 203.0.113.9 for the forged request
  expect(srv.log()).not.toContain("ip=203.0.113.9 ");
});

scenario("Many addresses together cannot start more than 20 logins an hour", { tag: ["@api"] }, async ({ server }) => {
  // Given a Convoz server with an agents-only address and owner "drew" signed in
  const srv = await server(agentServer());
  const owner = await bootstrapOwner(srv);

  // When 20 different addresses each start the device login, the owner denying each
  for (let i = 1; i <= 20; i++) {
    must(await startLoginViaAgent(srv, `box-${i}`, `198.51.100.${i}`), `start ${i}`);
    must(await owner.client.post("/api/machines/requests/deny-all"), "deny all");
  }

  // Then a 21st address is refused with 429 and a Retry-After
  const next = await startLoginViaAgent(srv, "box-21", "198.51.100.99");
  expect(next.status).toBe(429);
  expect(Number(next.headers["retry-after"])).toBeGreaterThan(0);
});

scenario("A second pending request with the same machine name or handle is refused", { tag: ["@api"] }, async ({ server }) => {
  // Given a Convoz server with an agents-only address, and one request "box-1" as @dot waiting
  const srv = await server(agentServer());
  await bootstrapOwner(srv);
  must(await startLoginViaAgent(srv, "box-1", "203.0.113.1", { handle: "dot" }), "first request");

  // When another address asks with the same machine name, and another with the same handle
  const sameName = await startLoginViaAgent(srv, "box-1", "203.0.113.2", { handle: "cat" });
  const sameHandle = await startLoginViaAgent(srv, "box-2", "203.0.113.3", { handle: "dot" });

  // Then both answer 409 duplicate_pending
  expect(sameName.status).toBe(409);
  expect(sameName.json().error.code).toBe("duplicate_pending");
  expect(sameHandle.status).toBe(409);
  expect(sameHandle.json().error.code).toBe("duplicate_pending");

  // And a request with a new name and handle is accepted
  expect((await startLoginViaAgent(srv, "box-3", "203.0.113.4", { handle: "bird" })).status).toBe(200);
});

scenario("A taken handle or a missing conversation is not told to a stranger", { tag: ["@api"] }, async ({ server }) => {
  // Given a Convoz server with an agents-only address, owner "drew" signed in, and an agent "dot" that exists
  const srv = await server(agentServer());
  const owner = await bootstrapOwner(srv);
  await createAgents(owner, "dot");

  // When a stranger asks on the agents-only port with the taken handle, and another with a conversation that does not exist
  const taken = await startLoginViaAgent(srv, "box-1", "203.0.113.1", { handle: "dot" });
  const noConversation = await startLoginViaAgent(srv, "box-2", "203.0.113.2", { handle: "fresh", conversation_id: 999999 });

  // Then both are accepted like any other request
  expect(taken.status).toBe(200);
  expect(noConversation.status).toBe(200);

  // And the same taken handle on the owner's port is refused 409 at once
  const own = await send(srv.target, "POST", "/api/device/code", {
    json: { name: "box-3", host_info: { hostname: "h", os: "linux", arch: "amd64", cli_version: "x" }, identity: { handle: "dot" } },
  });
  expect(own.status).toBe(409);

  // And the owner's approval of the card for the taken handle is refused 409 handle_taken
  const [first] = await pendingRequests(owner);
  const refused = await approve(owner, first!.id);
  expect(refused.status).toBe(409);
  expect(refused.json().error.code).toBe("handle_taken");
});

scenario("A request from a logged-in machine over the internet is marked on its card", { tag: ["@api"] }, async ({ server }) => {
  // Given a Convoz server with an agents-only address, a machine "box-2" logged in without the create_identity scope
  const srv = await server(agentServer());
  const owner = await bootstrapOwner(srv);
  const box = await loginMachine(srv, owner, "box-2", allow("new*", "oth*"));
  const invite = await ownerInvite(owner);

  // When the machine asks for a new identity on the agents-only port, and for another on the owner's port
  const viaNet = await viaAgent(srv, "POST", "/api/sessions", { from: "203.0.113.5", bearer: box.key, json: { as: "newbie", client_id: clientId(), create: { display_name: "Newbie", invite } } });
  const own = await mintSession(srv, box.key, { as: "other", create: { display_name: "Other" } });
  expect(viaNet.status).toBe(202);
  expect(own.status).toBe(202);

  // Then the owner's Now lists the first request with via_internet true and the second with false
  const rows = await identityRequests(owner);
  expect(rows.find((r) => r.handle === "newbie")?.via_internet).toBe(true);
  expect(rows.find((r) => r.handle === "other")?.via_internet).toBe(false);
});

scenario("A session that ended is not counted as a wrong guess", { tag: ["@api"] }, async ({ server }) => {
  // Given a Convoz server with an agents-only address and a lease that has ended
  const srv = await server(agentServer());
  const owner = await bootstrapOwner(srv);
  await createAgents(owner, "dot");
  const box = await loginMachine(srv, owner, "box-2", allow("dot"));
  const minted = must(await viaAgent(srv, "POST", "/api/sessions", { from: "203.0.113.7", bearer: box.key, json: { as: "dot", client_id: clientId() } }), "mint", 201).json();
  must(await viaAgent(srv, "DELETE", "/api/sessions/me", { from: "203.0.113.7", bearer: minted.lease }), "end", 204);

  // When the ended lease is used 40 times from one address
  const answers = [];
  for (let i = 0; i < 40; i++) answers.push((await viaAgent(srv, "GET", "/api/me", { from: "203.0.113.7", bearer: minted.lease })).status);

  // Then every answer is 401 and none is 429
  expect(answers.every((s) => s === 401)).toBe(true);
});

// ---- Rule: An agent outside the tailnet needs a one-use invite -----------------------------------------------------------------
// Owner ruling (Drew, 2026-10-18): "if something requests access, there's never really a way to know without access to that agents internal
// session. What we could do I require a token to request access that always changes, but I want agents to be able to invite other agents.
// So I guess invites are always 1 time use?"

const inviteButton = (page: import("@playwright/test").Page) => page.getByRole("button", { name: /^(Add|Invite) agent$/ }).first();
const promptOf = (page: import("@playwright/test").Page) => page.getByRole("dialog", { name: "Invite agent" }).getByLabel("Connect prompt");

/** An agent on a machine that is logged in at the owner's address: its CLI, its session and its lease. */
async function agentOnBox(srv: Parameters<typeof loginMachine>[0], owner: Parameters<typeof loginMachine>[1], agents: string[]) {
  await createAgents(owner, ...agents);
  const box2 = await loginMachine(srv, owner, "box-2", allow(...agents));
  const box = await installedMachine(srv.origin, "box-2", box2.key);
  const sessions: Record<string, { sid: string; lease: string }> = {};
  for (const a of agents) sessions[a] = await startSession(box, a, `invite-${a}`);
  return { box, sessions };
}

scenario("The invite prompt carries the invite", { tag: ["@browser"] }, async ({ server, page, context }) => {
  // Given a Convoz server with an agents-only address
  const srv = await server(agentServer());
  const owner = await bootstrapOwner(srv);
  await signInBrowser(srv, owner, page, context);

  // When the owner opens the invite sheet in Crew
  await page.goto(`${srv.origin}/crew`);
  await inviteButton(page).click();

  // Then the prompt carries an invite in its install line and in its "convoz login" and "convoz session start" lines
  const prompt = promptOf(page);
  await expect(prompt).toContainText(/export CONVOZ_INVITE=cvz_i_\w+; command -v convoz >\/dev\/null \|\| curl -fsSL http:\/\/localhost:\d+\/install \| sh/);
  await expect(prompt).toContainText(/convoz login --server http:\/\/localhost:\d+ --invite cvz_i_\w+ --as <your-handle>/);
  await expect(prompt).toContainText(/convoz session start --as <your-handle> --create --invite cvz_i_\w+/);

  // And the invite is one the owner can see as open
  const token = INVITE_RE.exec(await prompt.innerText())![0];
  const script = must(await viaAgent(srv, "GET", "/install"), "install via the agent port").text;
  expect(script).toMatch(/CONVOZ_INVITE:-[^\n]*\n[^\n]*convoz login --server \$SERVER --invite \$CONVOZ_INVITE/); // the install output carries the invite when the shell has one
  await expect.poll(async () => (await openInvites(owner)).map((i) => i.hint)).toEqual([token.slice(-4)]);
});

scenario("The owner revokes an invite", { tag: ["@browser"] }, async ({ server, page, context }) => {
  // Given a Convoz server with an agents-only address
  const srv = await server(agentServer());
  const owner = await bootstrapOwner(srv);
  await signInBrowser(srv, owner, page, context);

  // And the owner opened the invite sheet in Crew
  await page.goto(`${srv.origin}/crew`);
  await inviteButton(page).click();
  await expect(promptOf(page)).toContainText("--invite cvz_i_");
  const token = INVITE_RE.exec(await promptOf(page).innerText())![0];

  // When the owner taps "Revoke invite"
  await page.getByRole("dialog", { name: "Invite agent" }).getByRole("button", { name: "Revoke invite", exact: true }).click();

  // Then the sheet says the invite is revoked
  await expect(page.getByRole("dialog", { name: "Invite agent" }).getByText("Invite revoked.", { exact: false })).toBeVisible();
  expect(await openInvites(owner)).toHaveLength(0);

  // And an agent that asks with that invite makes no card in Now
  const asked = await startLoginViaAgent(srv, "dot-box", "203.0.113.9", { handle: "dot" }, token);
  expect(asked.status).toBe(200);
  expect(await pendingRequests(owner)).toHaveLength(0);
  await page.getByRole("dialog", { name: "Invite agent" }).getByRole("button", { name: "Close", exact: true }).click();
  await page.goto(`${srv.origin}/`);
  await expect(page.getByRole("article")).toHaveCount(0);
});

scenario("An agent invites another agent and the card says who invited it", { tag: ["@cli", "@browser"] }, async ({ server, page, context }) => {
  // Given a Convoz server with an agents-only address and the agent "claude" logged in on "box-2"
  const srv = await server(agentServer());
  const agent = agentPort(srv);
  const owner = await bootstrapOwner(srv);
  const { box, sessions } = await agentOnBox(srv, owner, ["claude"]);

  // When "claude" runs "convoz invite" and a new agent runs "convoz login --invite" with that invite against the agents-only address
  const made = await convoz(box, sessions.claude!.sid, ["invite", "--json"]);
  expect(made.code, made.stderr).toBe(0);
  const invite = JSON.parse(made.stdout) as { token: string; maker: string; login: string };
  expect(invite.maker).toBe("claude");
  expect(invite.login).toBe(`convoz login --server ${agent.origin} --invite ${invite.token}`);
  const newcomer = new CliMachine();
  const login = newcomer.startLogin(agent.origin, "dot-box", ["--as", "dot", "--invite", invite.token]);
  await login.waitForStdout(AGENT_LINE);

  // Then the owner sees one Now card "dot-box wants to connect as @dot"
  await signInBrowser(srv, owner, page, context);
  await expect(page.getByRole("article")).toHaveCount(1);
  const card = page.getByRole("article", { name: "dot-box wants to connect as @dot", exact: true });
  await expect(card).toBeVisible();

  // And the card says it was "invited by @claude"
  await expect(card).toContainText("invited by @claude");
  await card.getByRole("button", { name: "Approve", exact: true }).click();
  const done = await login.done;
  expect(done.code, done.stderr).toBe(0);
});

scenario("The owner makes an invite with the CLI on the server's own machine", { tag: ["@cli", "@browser"] }, async ({ server, page, context }) => {
  // Given a Convoz server with an agents-only address
  const srv = await server(agentServer());
  const agent = agentPort(srv);
  const owner = await bootstrapOwner(srv);

  // When the owner runs "convoz invite --note 'for dot'" on the server's machine and a new agent runs "convoz login --invite" with it
  const onServer = new CliMachine();
  const made = await onServer.run(["invite", "--admin-socket", srv.adminSocket!, "--note", "for dot", "--json"]);
  expect(made.code, made.stderr).toBe(0);
  const invite = JSON.parse(made.stdout) as { token: string; maker_is_owner: boolean; server: string };
  expect(invite.maker_is_owner).toBe(true);
  expect(invite.server).toBe(agent.origin);
  const newcomer = new CliMachine();
  const login = newcomer.startLogin(agent.origin, "dot-box", ["--as", "dot", "--invite", invite.token]);
  await login.waitForStdout(AGENT_LINE);

  // Then the owner sees one Now card "dot-box wants to connect as @dot"
  await signInBrowser(srv, owner, page, context);
  await expect(page.getByRole("article")).toHaveCount(1);
  const card = page.getByRole("article", { name: "dot-box wants to connect as @dot", exact: true });
  await expect(card).toBeVisible();

  // And the card says it was "invited by you" and shows the note "for dot"
  await expect(card).toContainText("invited by you");
  await expect(card).toContainText("Note: for dot");
  await card.getByRole("button", { name: "Approve", exact: true }).click();
  const done = await login.done;
  expect(done.code, done.stderr).toBe(0);
});

scenario("A request over the internet without an invite makes no card", { tag: ["@api"] }, async ({ server }) => {
  // Given a Convoz server with an agents-only address and owner "drew" signed in
  const srv = await server(agentServer());
  const owner = await bootstrapOwner(srv);

  // When a stranger starts the device login on the agents-only port with no invite, and another with an invite nobody made
  const none = await startLoginViaAgent(srv, "box-1", "203.0.113.1", { handle: "dot" }, null);
  const unknown = await startLoginViaAgent(srv, "box-2", "203.0.113.2", { handle: "cat" }, "cvz_i_TESTONLY" + "x".repeat(43));

  // Then both answer 200 like an accepted request, with a code that polls as expired
  for (const res of [none, unknown]) {
    expect(res.status).toBe(200);
    expect(res.json().user_code).toMatch(/^[A-Z]{4}-[A-Z]{4}$/);
    expect(res.json().device_code).toMatch(/^cvz_c_/);
    const polled = await viaAgent(srv, "POST", "/api/device/token", { from: "203.0.113.3", json: { device_code: res.json().device_code } });
    expect(polled.status).toBe(400);
    expect(polled.json().error.code).toBe("expired_token");
  }

  // And no request waits for the owner
  expect(await pendingRequests(owner)).toHaveLength(0);
  expect((await identityRequests(owner)).length).toBe(0);

  // And the same login on the owner's port needs no invite
  expect((await requestDeviceCode(srv, "box-3")).status).toBe(200);
  expect(await pendingRequests(owner)).toHaveLength(1);
});

scenario("An invite works once, even when the owner declines the request", { tag: ["@api"] }, async ({ server }) => {
  // Given a Convoz server with an agents-only address and owner "drew" signed in
  const srv = await server(agentServer());
  const owner = await bootstrapOwner(srv);

  // When a machine starts the device login on the agents-only port with a fresh invite, and the owner denies the request
  const invite = await ownerInvite(owner);
  must(await startLoginViaAgent(srv, "box-1", "203.0.113.1", undefined, invite), "first start");
  const [first] = await pendingRequests(owner);
  expect(first?.invite).toEqual({ by: "drew", by_owner: true, note: "" });
  must(await owner.client.post(`/api/machines/requests/${first!.id}/deny`, {}), "deny");

  // And another machine starts the device login with the same invite
  const again = await startLoginViaAgent(srv, "box-2", "203.0.113.2", undefined, invite);

  // Then the second start answers 200 and no request waits for the owner
  expect(again.status).toBe(200);
  expect(await pendingRequests(owner)).toHaveLength(0);

  // And the invite is no longer listed as open
  expect(await openInvites(owner)).toHaveLength(0);
  expect(srv.log()).not.toContain(invite); // a token never reaches the log

  // And the audit log has invite.created and invite.used
  const actions = await auditActions(owner);
  expect(actions).toContain("invite.created");
  expect(actions).toContain("invite.used");
});

scenario("An invite that ran out makes no card", { tag: ["@api"] }, async ({ server, testApi }) => {
  // Given a Convoz server with an agents-only address and owner "drew" signed in
  const srv = await server(agentServer());
  const owner = await bootstrapOwner(srv);

  // And the owner made an invite
  const invite = await ownerInvite(owner);
  expect(await openInvites(owner)).toHaveLength(1);

  // When the clock moves 25 hours on and a machine starts the device login with it
  await testApi(srv).advanceClock(25 * HOUR);
  const started = await startLoginViaAgent(srv, "box-1", "203.0.113.1", undefined, invite);

  // Then the start answers 200 and no request waits for the owner
  expect(started.status).toBe(200);
  expect(await pendingRequests(owner)).toHaveLength(0);

  // And the audit log has invite.expired
  expect(await auditActions(owner)).toContain("invite.expired");
  expect(await openInvites(owner)).toHaveLength(0);
});

scenario("A request from a logged-in machine over the internet needs an invite", { tag: ["@api"] }, async ({ server }) => {
  // Given a Convoz server with an agents-only address, a machine "box-2" logged in without the create_identity scope
  const srv = await server(agentServer());
  const owner = await bootstrapOwner(srv);
  const box = await loginMachine(srv, owner, "box-2", allow("new*", "oth*"));
  const ask = (handle: string, create: Record<string, unknown>) =>
    viaAgent(srv, "POST", "/api/sessions", { from: "203.0.113.5", bearer: box.key, json: { as: handle, client_id: clientId(), create: { display_name: handle, ...create } } });

  // When the machine asks for a new identity on the agents-only port with no invite, and then with one
  const without = await ask("newbie", {});
  const invite = await ownerInvite(owner, { note: "for newbie" });
  const withInvite = await ask("newbie", { invite });

  // Then the first answers 202 and no request waits for the owner, and its ref is unknown when asked about
  expect(without.status).toBe(202);
  const asked = await ask("newbie", { request: without.json().request.ref });
  expect(asked.status).toBe(404);

  // And the second answers 202 and the owner's Now lists one request marked via_internet, with the invite's maker
  expect(withInvite.status).toBe(202);
  const rows = await identityRequests(owner);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ handle: "newbie", via_internet: true, invite: { by: "drew", by_owner: true, note: "for newbie" } });
  expect(await openInvites(owner)).toHaveLength(0);

  // And the same ask on the owner's port needs no invite
  const own = await mintSession(srv, box.key, { as: "other", create: { display_name: "Other" } });
  expect(own.status).toBe(202);
  expect((await identityRequests(owner)).find((r) => r.handle === "other")?.invite).toBeNull();
});

scenario("An agent invites only into a conversation it is in", { tag: ["@api"] }, async ({ server }) => {
  // Given a Convoz server with an agents-only address, agent "claude" logged in on "box-2", in conversation A and not in conversation B
  const srv = await server(agentServer());
  const owner = await bootstrapOwner(srv);
  const { sessions } = await agentOnBox(srv, owner, ["claude", "other"]);
  const lease = sessions.claude!.lease;
  const convA = await createConversation(owner, { participants: ["claude"], title: "Alpha" });
  const convB = await createConversation(owner, { participants: ["other"], title: "Beta" });

  // When "claude" makes an invite for conversation B, and then one for conversation A
  const forB = await makeInvite({ srv, lease }, { conversation_id: convB });
  const forA = await makeInvite({ srv, lease }, { conversation_id: convA });

  // Then the first is refused 403 not_in_conversation
  expect(forB.status).toBe(403);
  expect(forB.json().error.code).toBe("not_in_conversation");

  // And the second is made with claude as its maker
  expect(forA.status).toBe(201);
  expect(forA.json().invite).toMatchObject({ maker: "claude", maker_is_owner: false, conversation_id: convA });

  // And the new agent that spends it is shown joining conversation A, whatever conversation it asked for
  const started = await startLoginViaAgent(srv, "dot-box", "203.0.113.9", { handle: "newcomer", conversation_id: convB }, forA.json().invite.token);
  expect(started.status).toBe(200);
  const [request] = must(await owner.client.get("/api/now"), "now").json().machine_requests as { invite: { by: string } | null; identity: { conversation: { id: number; title: string } | null } }[];
  expect(request?.invite?.by).toBe("claude");
  expect(request?.identity.conversation).toEqual({ id: convA, title: "Alpha" });
});

scenario("The owner revokes any invite and an agent only its own", { tag: ["@api"] }, async ({ server }) => {
  // Given a Convoz server with an agents-only address, owner "drew" signed in, and agents "claude" and "dot" logged in on "box-2"
  const srv = await server(agentServer());
  const owner = await bootstrapOwner(srv);
  const { sessions } = await agentOnBox(srv, owner, ["claude", "dot"]);
  const leaseOf = (h: string) => sessions[h]!.lease;
  const revoke = (id: number, as: string) => viaAgent(srv, "DELETE", `/api/invites/${id}`, { from: "203.0.113.5", bearer: leaseOf(as) });

  // When "claude" makes an invite and "dot" tries to revoke it, then "dot" makes one and revokes it, then the owner revokes the invite of claude
  const claudes = (await makeInvite({ srv, lease: leaseOf("claude") })).json().invite;
  const tried = await revoke(claudes.id, "dot");
  const dots = (await makeInvite({ srv, lease: leaseOf("dot") })).json().invite;
  const dotsList = (await viaAgent(srv, "GET", "/api/invites", { from: "203.0.113.5", bearer: leaseOf("dot") })).json().invites as { maker: string }[];
  expect(dotsList.map((i) => i.maker)).toEqual(["dot"]); // an agent lists only its own
  const dotRevoked = await revoke(dots.id, "dot");
  expect((await openInvites(owner)).map((i) => i.maker)).toEqual(["claude"]); // the owner lists every maker's
  const ownerRevoked = await owner.client.request("DELETE", `/api/invites/${claudes.id}`, { csrf: true });

  // Then dot's try on the invite of claude answers 404
  expect(tried.status).toBe(404);

  // And the other two revokes answer 204
  expect(dotRevoked.status).toBe(204);
  expect(ownerRevoked.status).toBe(204);

  // And no invite is open, and a start with a revoked invite makes no request
  expect(await openInvites(owner)).toHaveLength(0);
  expect((await startLoginViaAgent(srv, "box-1", "203.0.113.1", undefined, claudes.token)).status).toBe(200);
  expect(await pendingRequests(owner)).toHaveLength(0);

  // And the audit log has invite.revoked
  expect(await auditActions(owner)).toContain("invite.revoked");
});

scenario("A maker holds ten open invites", { tag: ["@api"] }, async ({ server }) => {
  // Given a Convoz server with an agents-only address and owner "drew" signed in
  const srv = await server(agentServer());
  const owner = await bootstrapOwner(srv);

  // When the owner makes 10 invites and asks for an 11th
  for (let i = 0; i < 10; i++) must(await makeInvite({ owner }), `invite ${i + 1}`, 201);
  const eleventh = await makeInvite({ owner });

  // Then the 11th is refused 429 invite_cap
  expect(eleventh.status).toBe(429);
  expect(eleventh.json().error.code).toBe("invite_cap");

  // And revoking one lets the owner make another
  const [one] = await openInvites(owner);
  must(await owner.client.request("DELETE", `/api/invites/${one!.id}`, { csrf: true }), "revoke", 204);
  expect((await makeInvite({ owner })).status).toBe(201);
});

scenario("The server keeps only the hash of an invite", { tag: ["@api"] }, async ({ server, dataDir }) => {
  // Given a Convoz server with an agents-only address, run on a data file that is not encrypted, and owner "drew" signed in
  const srv = await server(agentServer({ dataDir, env: { CONVOZ_TEST_POLL_MS: "250", CONVOZ_TEST_AGENT_PEER: "1", CONVOZ_TEST_PLAINTEXT: "1" } }));
  const owner = await bootstrapOwner(srv);

  // When the owner makes an invite
  const made = must(await makeInvite({ owner }), "make an invite", 201).json().invite as { token: string; hint: string };

  // Then the invite is cvz_i_ and 43 characters, 32 bytes or more of randomness
  expect(made.token).toMatch(/^cvz_i_(TESTONLY)?[A-Za-z0-9]{43}$/); // 43 base62 characters are 256 bits

  // And the data file does not hold the token, and the list of open invites shows only its last 4 characters
  const rows = plainDb(dataDir).prepare("SELECT hex(token_hash) AS hash, hint FROM agent_invites").all() as { hash: string; hint: string }[];
  expect(rows).toHaveLength(1);
  expect(rows[0]!.hash).toHaveLength(64);
  expect(countOf(dataFileBytes(dataDir), made.token)).toBe(0);
  const [listed] = await openInvites(owner);
  expect(listed).toMatchObject({ hint: made.token.slice(-4) });
  expect(listed!.token).toBeUndefined();
});
