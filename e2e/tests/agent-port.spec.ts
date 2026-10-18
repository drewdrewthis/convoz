import { CliMachine } from "../lib/cli.ts";
import { agentPort, agentServer, startLoginViaAgent, viaAgent } from "../lib/agent-port.ts";
import { clientId, createAgents, pendingRequests, approve, allow, signInBrowser } from "../lib/machines.ts";
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
 */

const AGENT_LINE = /Approve "([a-z0-9.-]+)" as @([a-z0-9-]+) in Convoz\. Code: ([A-Z]{4}-[A-Z]{4})/;

scenario("An agent outside the tailnet connects with one tap", { tag: ["@cli", "@browser"] }, async ({ server, page, context }) => {
  // Given a Convoz server with an agents-only address
  const srv = await server(agentServer());
  const agent = agentPort(srv);
  const owner = await bootstrapOwner(srv);

  // When "convoz login --name dot-box --as dot" runs against the agents-only address
  const box = new CliMachine();
  const login = box.startLogin(agent.origin, "dot-box", ["--as", "dot"]);

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
