import { CliMachine, installedMachine, sidOf } from "../lib/cli.ts";
import { agentPort, agentServer, ownerInvite } from "../lib/agent-port.ts";
import { agentSays, createConversation, messagesOf, startSession } from "../lib/chat.ts";
import { allow, createAgents, loginMachine, mintSession, revokeAgentKey, signInBrowser, whoamiApi } from "../lib/machines.ts";
import { bootstrapOwner, must } from "../lib/owner.ts";
import { expect, scenario } from "../lib/scenario.ts";

/*
 * crew.feature, "A revoked agent can be invited back as the same agent". Owner (Drew, msg 140): "I revoked dots token and reinvited…".
 *   Approving a login (or a request of a logged-in machine) for the handle of a revoked agent of the owner brings that same identity
 *   back (same id, handle, history, conversation seats). Old keys and sessions stay dead; the new machine gets a fresh key.
 *   A request for it is filed only with a usable invite (a plain login as a revoked handle stays refused: "A handle is never used again").
 *   The Now card says "Brings back @<handle> (revoked YYYY-MM-DD)". An active machine with the requested name that serves no enabled agent
 *   is revoked by the approval (audit machine.replaced); one that serves an enabled agent keeps the name (409 machine_name_taken).
 */

const AGENT_LINE = /Approve "([a-z0-9.-]+)" as @([a-z0-9-]+) in Convoz\. Code: ([A-Z]{4}-[A-Z]{4})/;

type Srv = Parameters<typeof loginMachine>[0];
type Owner = Parameters<typeof loginMachine>[1];

/** Agents logged in on "box-2" with one session each. */
async function agentsOnBox(srv: Srv, owner: Owner, handles: string[]) {
  const made = await createAgents(owner, ...handles);
  const machine = await loginMachine(srv, owner, "box-2", allow(...handles));
  const box = await installedMachine(srv.origin, "box-2", machine.key);
  const sessions: Record<string, { sid: string; lease: string }> = {};
  for (const h of handles) sessions[h] = await startSession(box, h, `reinvite-${h}`);
  return { made, machine, sessions };
}

/** The owner makes an invite and "dot" asks to connect as @dot from a new machine named "box-2". */
async function reinviteDot(srv: Srv, owner: Owner) {
  const newcomer = new CliMachine();
  const login = newcomer.startLogin(agentPort(srv).origin, "box-2", ["--as", "dot", "--invite", await ownerInvite(owner)]);
  await login.waitForStdout(AGENT_LINE);
  return { newcomer, login };
}

const identities = async (owner: Owner) =>
  must(await owner.client.get("/api/identities"), "identities").json().identities as { id: number; handle: string; disabled?: boolean }[];

const activeBox2 = async (owner: Owner) =>
  (must(await owner.client.get("/api/machines"), "machines").json().machines as { id: number; name: string }[]).filter((m) => m.name === "box-2");

scenario("Revoking an agent and inviting it again from the same machine brings the same agent back", { tag: ["@cli", "@browser"] }, async ({ server, page, context }) => {
  // Given a Convoz server with an agents-only address
  const srv = await server(agentServer());
  const owner = await bootstrapOwner(srv);

  // And "dot" is logged in on "box-2" and posted in the conversation "Ship search filters"
  const { made, machine, sessions } = await agentsOnBox(srv, owner, ["dot"]);
  const conv = await createConversation(owner, { participants: ["dot"], title: "Ship search filters" });
  await agentSays(srv, sessions.dot!.lease, conv, "Before the revoke");

  // And the owner revoked the key of "dot" with Revoke key and Confirm
  must(await revokeAgentKey(owner, made.dot!.id), "revoke dot");

  // When the owner makes an invite and "dot" runs "convoz login --name box-2 --as dot --invite" with it
  const { newcomer, login } = await reinviteDot(srv, owner);

  // Then the owner sees one Now card "box-2 wants to connect as @dot"
  await signInBrowser(srv, owner, page, context);
  await expect(page.getByRole("article")).toHaveCount(1);
  const card = page.getByRole("article", { name: "box-2 wants to connect as @dot", exact: true });
  await expect(card).toBeVisible();

  // And the card says "Brings back @dot" and the day the key was revoked
  await expect(card).toContainText(/Brings back @dot \(revoked \d{4}-\d{2}-\d{2}\)/);

  // When the owner taps Approve on that card
  await card.getByRole("button", { name: "Approve", exact: true }).click();

  // Then the CLI logs in as machine "box-2"
  const done = await login.done;
  expect(done.code, done.stderr).toBe(0);
  expect(done.stdout).toContain('Logged in as machine "box-2".');

  // And Crew lists one "dot", enabled, the same agent as before
  const dots = (await identities(owner)).filter((i) => i.handle === "dot");
  expect(dots.map((i) => i.id)).toEqual([made.dot!.id]);
  expect(dots[0]!.disabled).toBeFalsy();

  // And "dot" posts again in "Ship search filters" and its old message is still there
  const started = await newcomer.sessionStart("dot", [], { claude: "claude-TESTONLY-reinvite-back" });
  expect(started.code, started.stderr).toBe(0);
  await agentSays(srv, newcomer.leaseOf(sidOf(started)), conv, "Back again");
  const said = (await messagesOf(owner, conv)).filter((m) => m.author.handle === "dot").map((m) => m.body);
  expect(said).toEqual(["Before the revoke", "Back again"]);

  // And Crew lists one active machine "box-2", the new one
  const boxes = await activeBox2(owner);
  expect(boxes).toHaveLength(1);
  expect(boxes[0]!.id).not.toBe(machine.id);
});

scenario("A revoked agent's old key and sessions stay dead when it comes back", { tag: ["@cli", "@browser"] }, async ({ server, page, context }) => {
  // Given a Convoz server with an agents-only address
  const srv = await server(agentServer());
  const owner = await bootstrapOwner(srv);

  // And "dot" is logged in on "box-2" with a session
  const { made, machine, sessions } = await agentsOnBox(srv, owner, ["dot"]);

  // And the owner revoked the key of "dot" with Revoke key and Confirm
  must(await revokeAgentKey(owner, made.dot!.id), "revoke dot");

  // When the owner makes an invite and "dot" runs "convoz login --name box-2 --as dot --invite" with it
  const { newcomer, login } = await reinviteDot(srv, owner);

  // And the owner taps Approve on the card "box-2 wants to connect as @dot"
  await signInBrowser(srv, owner, page, context);
  await page.getByRole("article", { name: "box-2 wants to connect as @dot", exact: true }).getByRole("button", { name: "Approve", exact: true }).click();
  const done = await login.done;
  expect(done.code, done.stderr).toBe(0);

  // Then the old session of "dot" still fails
  expect((await whoamiApi(srv, sessions.dot!.lease)).status).toBe(401);

  // And the old machine key of "box-2" no longer works
  expect((await mintSession(srv, machine.key, { as: "dot" })).status).toBe(401);

  // And "convoz session start --as dot" works on the new "box-2"
  const started = await newcomer.sessionStart("dot");
  expect(started.code, started.stderr).toBe(0);
});

scenario("A machine that still serves an active agent keeps its name", { tag: ["@cli", "@browser"] }, async ({ server, page, context }) => {
  // Given a Convoz server with an agents-only address
  const srv = await server(agentServer());
  const owner = await bootstrapOwner(srv);

  // And "dot" and "writer" are logged in on "box-2"
  const { made, machine } = await agentsOnBox(srv, owner, ["dot", "writer"]);

  // And the owner revoked the key of "dot" with Revoke key and Confirm
  must(await revokeAgentKey(owner, made.dot!.id), "revoke dot");

  // When the owner makes an invite and "dot" runs "convoz login --name box-2 --as dot --invite" with it
  const { login } = await reinviteDot(srv, owner);

  // And the owner taps Approve on the card "box-2 wants to connect as @dot"
  await signInBrowser(srv, owner, page, context);
  await page.getByRole("article", { name: "box-2 wants to connect as @dot", exact: true }).getByRole("button", { name: "Approve", exact: true }).click();

  // Then the owner reads 'The name "box-2" is taken. Use Reveal or Regenerate on "box-2", or revoke it first.'
  await expect(page.getByText('The name "box-2" is taken. Use Reveal or Regenerate on "box-2", or revoke it first.')).toBeVisible();

  // And "dot" is still disabled
  expect((await identities(owner)).find((i) => i.handle === "dot")?.disabled).toBe(true);

  // And the machine "box-2" still works for "writer"
  expect((await activeBox2(owner)).map((m) => m.id)).toEqual([machine.id]);
  expect((await mintSession(srv, machine.key, { as: "writer" })).status).toBe(201);
  login.stop(); // the refused request still waits for a decision; do not wait for the CLI's own timeout
  await login.done;
});
