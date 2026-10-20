import { agentAsks, answerAsk, withdrawAsk } from "../lib/asks.ts";
import { agentPost, agentSays, convoz, inboxItems, messagesOf, ownerSays } from "../lib/chat.ts";
import { crewRow, crewWorld, sheetNamed } from "../lib/crew-wp9.ts";
import { Client, send } from "../lib/http.ts";
import { bearer, clientId, stepped } from "../lib/machines.ts";
import { must } from "../lib/owner.ts";
import { grantReadAll, readAllWorld, setReadAll } from "../lib/read-all.ts";
import { expect, scenario } from "../lib/scenario.ts";
import { asAgent, ownerDeletes } from "../lib/wp3.ts";
import { createConversation } from "../lib/chat.ts";

// read-all.feature and contracts/read-all.feature (owner msgs 784 and 1123). The routes these bindings rely on:
//   PUT /api/agents/:id/read-all {on}   O S(identity.read_all, target = the agent)   -> 200 {read_all}
//   GET /api/waiting                    L (an agent with the right)                  -> {now, asks, unanswered, plans, unread}
// "triage" is the agent with the right; it is never in conversation 41.

const MIN = 60_000;
const QUESTION = "Which release is the search filter in?";

// ---- features/read-all.feature ----------------------------------------------------------------------------------

scenario("The owner turns on reading everything in the agent profile", { tag: ["@browser"] }, async ({ server, page, context }) => {
  // Background: conversation 41 has "drew" and "devtool", "triage" is not in it, and "triage" runs a session on "box-2"
  let conv = 0;
  const c = await crewWorld({ server, page, context }, {
    agents: ["devtool", "triage"],
    live: ["triage"],
    beforeSignIn: async (x) => void (conv = await createConversation(x.w.owner, { title: "Ship search filters", participants: ["devtool"] })),
  });

  // When the owner opens the profile of "triage"
  await page.goto(`${c.w.srv.origin}/crew/triage`);

  // Then the profile has a switch "Can read all conversations" that is off
  const reads = page.getByRole("checkbox", { name: "Can read all conversations" });
  await expect(reads).not.toBeChecked();

  // And its help says what the agent can do and what it cannot, and where it signs in
  await expect(page.getByText("Reads every conversation and thread, and can post in them as itself. It can't answer your asks. Any process that can sign in as @triage on box-2 gets this.")).toBeVisible();

  // When the owner turns the switch on and does the passkey check
  await reads.click();
  await sheetNamed(page, "Let this agent read everything").getByRole("button", { name: "Allow" }).click();

  // Then the switch is on
  await expect(reads).toBeChecked();

  // And the Crew row of "triage" shows "Reads all"
  await page.goto(`${c.w.srv.origin}/crew`);
  await expect(crewRow(page, "triage")).toContainText("Reads all");

  // And conversation 41 has no new message
  expect(await messagesOf(c.w.owner, conv)).toEqual([]);
});

scenario("A granted agent reads a conversation it is not in", { tag: ["@cli"] }, async ({ server }) => {
  // Given the owner turned on reading everything for "triage"
  const r = await readAllWorld(server);
  await grantReadAll(r);

  // And "drew" wrote a message in conversation 41 and "devtool" replied in its thread
  const root = await ownerSays(r.w.owner, r.conv, QUESTION);
  must(await agentPost(r.w.srv, r.dev.lease, r.conv, "In 2.4, shipped Friday", { thread_root_id: root }), "thread reply", 201);

  // When "triage" runs "convoz read 41"
  const read = await convoz(r.w.box, r.tri.sid, ["read", String(r.conv)]);

  // Then it sees the message
  expect(read.code, read.stderr).toBe(0);
  expect(read.stdout).toContain(QUESTION);

  // And "convoz read 41 --thread" shows the reply of "devtool"
  const thread = await convoz(r.w.box, r.tri.sid, ["read", String(r.conv), "--thread", String(root)]);
  expect(thread.code, thread.stderr).toBe(0);
  expect(thread.stdout).toContain("In 2.4, shipped Friday");

  // And "convoz search release" finds the message
  const found = await convoz(r.w.box, r.tri.sid, ["search", "release"]);
  expect(found.code, found.stderr).toBe(0);
  expect(found.stdout).toContain(`#${root}`);
});

scenario("A granted agent posts in a conversation it is not in, as itself", { tag: ["@cli"] }, async ({ server }) => {
  // Given the owner turned on reading everything for "triage"
  const r = await readAllWorld(server);
  await grantReadAll(r);

  // When "triage" runs "convoz post --fyi 41 'Nothing waits on you here'"
  const posted = await convoz(r.w.box, r.tri.sid, ["post", "--fyi", String(r.conv), "Nothing waits on you here"]);
  expect(posted.code, posted.stderr).toBe(0);

  // Then conversation 41 shows the message from "triage"
  const last = (await messagesOf(r.w.owner, r.conv)).at(-1);
  expect([last?.author.handle, last?.body]).toEqual(["triage", "Nothing waits on you here"]);

  // And "triage" is still not a participant of conversation 41
  const view = must(await r.w.owner.client.get(`/api/conversations/${r.conv}`), "conversation").json().conversation;
  expect((view.participants as { handle: string }[]).map((p) => p.handle).sort()).toEqual(["devtool", "drew"]);
});

scenario("A granted agent gets no inbox item from a conversation it is not in", { tag: ["@cli"] }, async ({ server }) => {
  // Given the owner turned on reading everything for "triage"
  const r = await readAllWorld(server);
  await grantReadAll(r);

  // When "drew" posts a message in conversation 41 and "devtool" posts "@triage have a look" (an agent's @mention adds nobody)
  await ownerSays(r.w.owner, r.conv, QUESTION);
  await agentSays(r.w.srv, r.dev.lease, r.conv, "@triage have a look");

  // Then "convoz inbox --peek" as "triage" shows no item
  expect(await inboxItems(r.w.box, r.tri.sid, ["--peek"])).toEqual([]);

  // And "triage" is still not a participant of conversation 41
  const view = must(await r.w.owner.client.get(`/api/conversations/${r.conv}`), "conversation").json().conversation;
  expect((view.participants as { handle: string }[]).map((p) => p.handle).sort()).toEqual(["devtool", "drew"]);

  // And no message shows a "Seen by" line for "triage"
  const page = must(await r.w.owner.client.get(`/api/conversations/${r.conv}/messages`), "messages").json();
  expect(JSON.stringify(page.seen ?? [])).not.toContain("triage");
  const plans = must(await r.w.owner.client.get("/api/plans"), "plans").json();
  expect(JSON.stringify(plans.attention)).not.toContain("triage");
});

scenario("Turning it off ends the reading on the next command", { tag: ["@cli"] }, async ({ server }) => {
  // Given the owner turned on reading everything for "triage" and "triage" read conversation 41
  const r = await readAllWorld(server);
  await ownerSays(r.w.owner, r.conv, QUESTION);
  await grantReadAll(r);
  const before = await convoz(r.w.box, r.tri.sid, ["read", String(r.conv)]);
  expect(before.code, before.stderr).toBe(0);

  // When the owner turns it off
  must(await setReadAll(r, false), "turn off");

  // Then "convoz read 41" as "triage" is refused
  const after = await convoz(r.w.box, r.tri.sid, ["read", String(r.conv)]);
  expect(after.code).not.toBe(0);
  expect(after.stdout).not.toContain(QUESTION);
});

scenario("convoz waiting lists an open ask, an unanswered message and a waiting plan item", { tag: ["@cli"] }, async ({ server, testApi }) => {
  // Given the owner turned on reading everything for "triage"
  const r = await readAllWorld(server);
  await grantReadAll(r);

  // And "devtool" asked "Merge #415 on its own?" in conversation 41
  const askId = await agentAsks(r.w.srv, r.dev.lease, r.conv, { question: "Merge #415 on its own?" });

  // And "devtool" has a plan in conversation 41 that waits on "Approve the dot card"
  const plan = await convoz(r.w.box, r.dev.sid, ["plan", String(r.conv), "--doing", "Building invites", "--waiting", "Approve the dot card"]);
  expect(plan.code, plan.stderr).toBe(0);

  // And "drew" wrote a message in conversation 41 and nobody answered for 10 minutes
  const msg = await ownerSays(r.w.owner, r.conv, QUESTION);
  await testApi(r.w.srv).advanceClock(11 * MIN);

  // When "triage" runs "convoz waiting --json"
  const res = await convoz(r.w.box, r.tri.sid, ["waiting", "--json"]);
  expect(res.code, res.stderr).toBe(0);
  const out = JSON.parse(res.stdout);

  // Then it lists the ask with its asker and age
  expect(out.asks.map((a: any) => [a.id, a.conversation.id, a.asker.handle, a.question])).toEqual([[askId, r.conv, "devtool", "Merge #415 on its own?"]]);
  expect(out.asks[0].age_ms).toBeGreaterThanOrEqual(10 * MIN);

  // And it lists the unanswered message of "drew" in conversation 41
  expect(out.unanswered.map((u: any) => [u.conversation.id, u.message_id, u.excerpt])).toEqual([[r.conv, msg, QUESTION]]);

  // And it lists the plan item
  expect(out.plans.map((p: any) => [p.conversation.id, p.agent.handle, p.text])).toEqual([[r.conv, "devtool", "Approve the dot card"]]);

  // And it lists the unread count of "drew" for conversation 41
  expect(out.unread.find((u: any) => u.conversation.id === r.conv)?.unread).toBeGreaterThanOrEqual(1);
});

// ---- contracts/read-all.feature ---------------------------------------------------------------------------------

scenario("Without the right an agent is refused a conversation it is not in", { tag: ["@api"] }, async ({ server }) => {
  const r = await readAllWorld(server);
  await ownerSays(r.w.owner, r.conv, QUESTION);

  // When "triage" reads conversation 41, lists conversations and posts in conversation 41
  const calls = [
    await asAgent(r.w.srv, r.tri.lease, "GET", `/api/conversations/${r.conv}`),
    await asAgent(r.w.srv, r.tri.lease, "GET", `/api/conversations/${r.conv}/messages`),
    await agentPost(r.w.srv, r.tri.lease, r.conv, "Hello"),
  ];
  const list = await asAgent(r.w.srv, r.tri.lease, "GET", "/api/conversations");

  // Then every call is refused with 403 and the list is empty
  expect(calls.map((c) => c.status)).toEqual([403, 403, 403]);
  expect(list.json().conversations).toEqual([]);
});

scenario("With the right an agent reads every part of a conversation it is not in", { tag: ["@api"] }, async ({ server }) => {
  // Given the owner turned on reading everything for "triage"
  const r = await readAllWorld(server);
  await grantReadAll(r);
  const root = await ownerSays(r.w.owner, r.conv, QUESTION);
  await agentPost(r.w.srv, r.dev.lease, r.conv, "In 2.4", { thread_root_id: root });
  const askId = await agentAsks(r.w.srv, r.dev.lease, r.conv, { question: "Merge #415 on its own?" });

  // When "triage" lists conversations, gets conversation 41, its messages, a thread, a message's edits and an ask of it
  const get = (path: string) => asAgent(r.w.srv, r.tri.lease, "GET", path);
  const list = await get("/api/conversations");
  const answers = [
    await get(`/api/conversations/${r.conv}`),
    await get(`/api/conversations/${r.conv}/messages`),
    await get(`/api/conversations/${r.conv}/messages?thread=${root}`),
    await get(`/api/messages/${root}/replies`),
    await get(`/api/messages/${root}/edits`),
    await get(`/api/asks/${askId}`),
    // And "triage" searches for a word of conversation 41
    await get("/api/search?q=release"),
  ];

  // Then every call answers 200 and the list holds conversation 41
  expect([list.status, ...answers.map((a) => a.status)]).toEqual([200, 200, 200, 200, 200, 200, 200, 200]);
  expect((list.json().conversations as { id: number }[]).map((c) => c.id)).toEqual([r.conv]);

  // And a conversation in the trash is refused with 403
  must(await ownerDeletes(r.w.owner, r.conv), "trash conversation 41");
  expect((await get(`/api/conversations/${r.conv}`)).status).toBe(403);
});

scenario("With the right an agent changes nothing in a conversation it is not in", { tag: ["@api"] }, async ({ server }) => {
  // Given the owner turned on reading everything for "triage" and "devtool" asked an open ask in conversation 41
  const r = await readAllWorld(server);
  await grantReadAll(r);
  const said = await agentSays(r.w.srv, r.dev.lease, r.conv, "Starting on it");
  const askId = await agentAsks(r.w.srv, r.dev.lease, r.conv, { question: "Merge #415 on its own?" });

  // When "triage" renames conversation 41, adds "docs" to it, starts an upload, writes a plan, says it is typing and answers or withdraws the ask
  const as = (method: string, path: string, json?: unknown) => asAgent(r.w.srv, r.tri.lease, method, path, json);
  const calls = {
    rename: await as("PATCH", `/api/conversations/${r.conv}`, { title: "Mine now" }),
    add: await as("POST", `/api/conversations/${r.conv}/participants`, { identity_id: r.ids.docs, history: "since_now" }),
    upload: await as("POST", "/api/uploads", { conversation_id: r.conv, kind: "file", filename: "a.txt", size: 0 }),
    plan: await as("PUT", `/api/conversations/${r.conv}/plan`, { doing: "Everything" }),
    typing: await as("POST", `/api/conversations/${r.conv}/typing`, {}),
    answer: await as("POST", `/api/asks/${askId}/answer`, { choice: "recommended" }),
    withdraw: await withdrawAsk(r.w.srv, r.tri.lease, askId),
    // And "triage" edits a message of "devtool" in it
    edit: await as("PATCH", `/api/messages/${said}`, { body: "Edited", client_id: clientId() }),
  };

  // Then every call is refused with 403
  expect(Object.fromEntries(Object.entries(calls).map(([k, v]) => [k, v.status]))).toEqual({
    rename: 403, add: 403, upload: 403, plan: 403, typing: 403, answer: 403, withdraw: 403, edit: 403,
  });
  expect((await answerAsk(r.w.owner, askId)).status).toBe(200); // the ask was still open for the owner
});

scenario("The right is looked up on every request", { tag: ["@api"] }, async ({ server }) => {
  // Given the owner turned on reading everything for "triage" and "triage" read conversation 41 with its session
  const r = await readAllWorld(server);
  await grantReadAll(r);
  const read = () => asAgent(r.w.srv, r.tri.lease, "GET", `/api/conversations/${r.conv}/messages`);
  expect((await read()).status).toBe(200);

  // When the owner turns it off
  must(await setReadAll(r, false), "turn off");

  // Then the same session reading conversation 41 is refused with 403 on its next request
  expect((await read()).status).toBe(403);
});

scenario("An agent session cannot open the event stream, with the right or without", { tag: ["@api"] }, async ({ server }) => {
  // Given the owner turned on reading everything for "triage"
  const r = await readAllWorld(server);
  await grantReadAll(r);

  // When "triage" opens the event stream, then it is refused with 403
  expect((await asAgent(r.w.srv, r.tri.lease, "GET", "/api/stream")).status).toBe(403);
});

scenario("Giving the right needs the owner and a passkey check", { tag: ["@api"] }, async ({ server }) => {
  const r = await readAllWorld(server);
  const route = `/api/agents/${r.ids.triage}/read-all`;

  // When "triage" tries to give itself the right with its session, a caller with no credential tries it, and the owner tries it with no passkey check
  const tries = [
    await send(r.w.srv.target, "PUT", route, { json: { on: true }, ...bearer(r.tri.lease) }),
    await new Client(r.w.srv.target).request("PUT", route, { csrf: true, json: { on: true } }),
    await r.w.owner.client.request("PUT", route, { csrf: true, json: { on: true } }),
  ];

  // Then the answers are 401, 401 and 403 "step_up_required"
  expect(tries.map((t) => t.status)).toEqual([401, 401, 403]);
  expect(tries[2]!.json().error.code).toBe("step_up_required");

  // And "triage" still cannot read conversation 41
  expect((await asAgent(r.w.srv, r.tri.lease, "GET", `/api/conversations/${r.conv}/messages`)).status).toBe(403);
});

scenario("The right is for an agent that is there", { tag: ["@api"] }, async ({ server }) => {
  const r = await readAllWorld(server);

  // When the owner gives the right to the owner's own identity and to an identity that does not exist
  const own = await stepped(r.w.owner, "PUT", `/api/agents/${r.ids.drew}/read-all`, { on: true }, "identity.read_all", r.ids.drew);
  const none = await stepped(r.w.owner, "PUT", "/api/agents/9999/read-all", { on: true }, "identity.read_all", 9999);

  // Then both are refused with 404
  expect([own.status, none.status]).toEqual([404, 404]);
});

scenario("Giving and taking the right is on the Crew list and in the audit trail", { tag: ["@api"] }, async ({ server }) => {
  const r = await readAllWorld(server);
  const flag = async () => {
    const list = must(await r.w.owner.client.get("/api/identities"), "identities").json().identities as { handle: string; read_all?: boolean }[];
    return list.find((i) => i.handle === "triage")?.read_all === true;
  };

  // When the owner turns the right on and off for "triage"
  must(await setReadAll(r, true), "on");
  const whileOn = await flag();
  must(await setReadAll(r, false), "off");

  // Then the Crew list marks "triage" while it is on and the audit trail holds both changes
  expect([whileOn, await flag()]).toEqual([true, false]);
  const audit = must(await r.w.owner.client.get("/api/admin/audit"), "audit").json().audit as { action: string; target_id: number }[];
  expect(audit.filter((a) => a.action.startsWith("identity.read_all") && a.target_id === r.ids.triage).map((a) => a.action).sort()).toEqual(["identity.read_all.off", "identity.read_all.on"]);
});

scenario("Only an agent with the right may ask what waits on the owner", { tag: ["@api"] }, async ({ server }) => {
  const r = await readAllWorld(server);

  // When "triage" asks for what waits without the right, and the owner asks with a device session
  const agent = await asAgent(r.w.srv, r.tri.lease, "GET", "/api/waiting");
  const owner = await r.w.owner.client.get("/api/waiting");

  // Then the answers are 403 and 401
  expect([agent.status, owner.status]).toEqual([403, 401]);
});
