import { agentAsks, answerAsk, nowOf, openNow, withdrawAsk } from "../lib/asks.ts";
import { agentPost, agentSays, convoz, createConversation, inboxItems, messagesOf, ownerSays, peekFor } from "../lib/chat.ts";
import { agentChoice, message } from "../lib/chat-ui.ts";
import { quietLine } from "../lib/plan.ts";
import { crewRow, crewWorld, sheetNamed } from "../lib/crew-wp9.ts";
import { Client, send } from "../lib/http.ts";
import { bearer, clientId, stepped } from "../lib/machines.ts";
import { must } from "../lib/owner.ts";
import { expect, scenario } from "../lib/scenario.ts";
import { agentAdds, agentJoins, agentRemoves, grantTriage, setTriage, triageWorld } from "../lib/triage.ts";
import { asAgent, handlesOf, linesOf, openChat, ownerAdds, ownerDeletes, ownerRemoves, showDetails, viewOf } from "../lib/wp3.ts";

// triage.feature and contracts/triage.feature (owner msgs 784, 1123 and 1217). The routes these bindings rely on:
//   PUT /api/agents/:id/triage {on}              O S(identity.triage, target = the agent)  -> 200 {triage}
//   GET /api/waiting                             L (a triage agent)                        -> {now, asks, unanswered, plans, unread}
//   POST /api/conversations/:id/join-requests {} L                                         -> 200|201 {participant:{identity_id, handle, status}}
//   POST|DELETE /api/conversations/:id/participants[/:iid]   a triage agent adds at once and removes, in any conversation
// "triage" is the triage agent; it is never in conversation 41 unless a scenario joins it.

const MIN = 60_000;
const QUESTION = "Which release is the search filter in?";

// ---- features/triage.feature ----------------------------------------------------------------------------------

scenario("The owner makes an agent a triage agent in the agent profile", { tag: ["@browser"] }, async ({ server, page, context }) => {
  // Background: conversation 41 has "drew" and "devtool", "triage" is not in it, and "triage" runs a session on "box-2"
  let conv = 0;
  const c = await crewWorld({ server, page, context }, {
    agents: ["devtool", "triage"],
    live: ["triage"],
    beforeSignIn: async (x) => void (conv = await createConversation(x.w.owner, { title: "Ship search filters", participants: ["devtool"] })),
  });

  // When the owner opens the profile of "triage"
  await page.goto(`${c.w.srv.origin}/crew/triage`);

  // Then the profile has a switch "Triage agent" that is off
  const reads = page.getByRole("checkbox", { name: "Triage agent" });
  await expect(reads).not.toBeChecked();

  // And its help says what the agent can do and what it cannot, and where it signs in
  await expect(page.getByText("Reads every conversation and thread, posts in any of them, and can add or remove agents in any chat, itself included. It can't answer your asks. Any process that can sign in as @triage on box-2 gets this.")).toBeVisible();

  // When the owner turns the switch on and does the passkey check
  await reads.click();
  await sheetNamed(page, "Make this a triage agent").getByRole("button", { name: "Allow" }).click();

  // Then the switch is on
  await expect(reads).toBeChecked();

  // And the profile shows a "Triage" badge next to the name of "triage"
  await expect(page.locator(".phead").getByRole("img", { name: "Triage agent" })).toBeVisible();

  // And the Crew row of "triage" shows a "Triage" badge
  await page.goto(`${c.w.srv.origin}/crew`);
  await expect(crewRow(page, "triage").getByRole("img", { name: "Triage agent" })).toBeVisible();

  // And conversation 41 has no new message
  expect(await messagesOf(c.w.owner, conv)).toEqual([]);
});

scenario("A triage agent reads a conversation it is not in", { tag: ["@cli"] }, async ({ server }) => {
  // Given the owner made "triage" a triage agent
  const r = await triageWorld(server);
  await grantTriage(r);

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

scenario("A triage agent posts in a conversation it is not in, as itself", { tag: ["@cli"] }, async ({ server }) => {
  // Given the owner made "triage" a triage agent
  const r = await triageWorld(server);
  await grantTriage(r);

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

scenario("A triage agent gets no inbox item from a conversation it is not in", { tag: ["@cli"] }, async ({ server }) => {
  // Given the owner made "triage" a triage agent
  const r = await triageWorld(server);
  await grantTriage(r);

  // When "drew" posts a message in conversation 41
  await ownerSays(r.w.owner, r.conv, QUESTION);

  // Then "convoz inbox --peek" as "triage" shows no item
  expect(await inboxItems(r.w.box, r.tri.sid, ["--peek"])).toEqual([]);

  // And "triage" is still not a participant of conversation 41, and no message shows a "Seen by" line for it
  const view = must(await r.w.owner.client.get(`/api/conversations/${r.conv}`), "conversation").json().conversation;
  expect((view.participants as { handle: string }[]).map((p) => p.handle).sort()).toEqual(["devtool", "drew"]);
  const page = must(await r.w.owner.client.get(`/api/conversations/${r.conv}/messages`), "messages").json();
  expect(JSON.stringify(page.seen ?? [])).not.toContain("triage");

  // When "devtool" mentions "@triage" (an agent's @mention brings the agent in, 74212e5)
  await agentSays(r.w.srv, r.dev.lease, r.conv, "@triage have a look");

  // Then "triage" is now a participant of conversation 41
  const after = must(await r.w.owner.client.get(`/api/conversations/${r.conv}`), "conversation").json().conversation;
  expect((after.participants as { handle: string }[]).map((p) => p.handle)).toContain("triage");
});

scenario("Turning it off ends the reading on the next command", { tag: ["@cli"] }, async ({ server }) => {
  // Given the owner made "triage" a triage agent and "triage" read conversation 41
  const r = await triageWorld(server);
  await ownerSays(r.w.owner, r.conv, QUESTION);
  await grantTriage(r);
  const before = await convoz(r.w.box, r.tri.sid, ["read", String(r.conv)]);
  expect(before.code, before.stderr).toBe(0);

  // When the owner turns it off
  must(await setTriage(r, false), "turn off");

  // Then "convoz read 41" as "triage" is refused
  const after = await convoz(r.w.box, r.tri.sid, ["read", String(r.conv)]);
  expect(after.code).not.toBe(0);
  expect(after.stdout).not.toContain(QUESTION);
});

scenario("convoz waiting lists an open ask, an unanswered message and a waiting plan item", { tag: ["@cli"] }, async ({ server, testApi }) => {
  // Given the owner made "triage" a triage agent
  const r = await triageWorld(server);
  await grantTriage(r);

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

scenario("A triage agent wears a badge wherever its name shows", { tag: ["@browser"] }, async ({ server, page, context }) => {
  // Given the owner made "triage" a triage agent
  let conv = 0;
  const c = await crewWorld({ server, page, context }, {
    agents: ["devtool", "triage", "docs"],
    live: ["devtool", "triage"],
    beforeSignIn: async (x) => {
      conv = await createConversation(x.w.owner, { title: "Ship search filters", participants: ["devtool"] });
      await grantTriage({ w: x.w, ids: x.ids });

      // And "triage" added itself to conversation 41 and posted "Nothing waits on you here" in it
      const joined = await convoz(x.w.box, x.sessions.triage!.sid, ["join", String(conv)]);
      expect(joined.code, joined.stderr).toBe(0);
      const posted = await convoz(x.w.box, x.sessions.triage!.sid, ["post", "--fyi", String(conv), "Nothing waits on you here"]);
      expect(posted.code, posted.stderr).toBe(0);
      await agentSays(x.w.srv, x.sessions.devtool!.lease, conv, "Starting on it");
    },
  });

  // When the owner opens conversation 41
  await openChat(page, c.w.srv, conv, "Ship search filters");

  // Then the message from "triage" shows a "Triage" badge next to its name
  await expect(message(page, "Nothing waits on you here").getByRole("img", { name: "Triage agent" })).toBeVisible();

  // And the same message from "devtool" would show no badge
  await expect(message(page, "Starting on it")).toBeVisible();
  await expect(message(page, "Starting on it").getByRole("img", { name: "Triage agent" })).toHaveCount(0);

  // When the owner opens the details of conversation 41
  const panel = await showDetails(page);

  // Then the agents list shows a "Triage" badge next to "@triage" and none next to "@devtool"
  const agents = panel.getByRole("list", { name: "Agents" }).getByRole("listitem");
  await expect(agents.filter({ hasText: "@triage" }).getByRole("img", { name: "Triage agent" })).toBeVisible();
  await expect(agents.filter({ hasText: "@devtool" })).toHaveCount(1);
  await expect(agents.filter({ hasText: "@devtool" }).getByRole("img", { name: "Triage agent" })).toHaveCount(0);

  // When the owner types "@" in the message box
  await openChat(page, c.w.srv, conv, "Ship search filters");
  await page.getByRole("textbox", { name: /^Message/ }).fill("@");

  // Then the agent picker shows a "Triage" badge next to "triage"
  await expect(agentChoice(page, "triage").getByRole("img", { name: "Triage agent" })).toBeVisible();
  await expect(agentChoice(page, "docs")).toBeVisible();
  await expect(agentChoice(page, "docs").getByRole("img", { name: "Triage agent" })).toHaveCount(0);
});

scenario("A triage agent adds an agent to a conversation it is not in", { tag: ["@cli"] }, async ({ server }) => {
  // Given the owner made "triage" a triage agent and "docs" is an agent on "box-2" that is not in conversation 41
  const r = await triageWorld(server);
  await grantTriage(r);

  // When "triage" runs "convoz add 41 @docs"
  const added = await convoz(r.w.box, r.tri.sid, ["add", String(r.conv), "@docs"]);

  // Then the CLI prints "@docs active"
  expect(added.code, added.stderr).toBe(0);
  expect(added.stdout.trim()).toBe("@docs active");

  // And conversation 41 says "@triage added @docs"
  expect((await linesOf(r.w.owner, r.conv)).at(-1)?.body).toBe("@triage added @docs");

  // And "docs" reads conversation 41
  expect((await asAgent(r.w.srv, r.doc.lease, "GET", `/api/conversations/${r.conv}/messages`)).status).toBe(200);

  // And the owner has no pending add in Now
  expect((await nowOf(r.w.owner)).pending_adds).toEqual([]);

  // And "triage" is still not a participant of conversation 41
  expect(handlesOf(await viewOf(r.w.owner, r.conv)).sort()).toEqual(["devtool", "docs", "drew"]);
});

scenario("A triage agent removes an agent from a conversation it is not in", { tag: ["@cli"] }, async ({ server }) => {
  // Given the owner made "triage" a triage agent and "devtool" is in conversation 41
  const r = await triageWorld(server);
  await grantTriage(r);

  // When "triage" runs "convoz remove 41 @devtool"
  const removed = await convoz(r.w.box, r.tri.sid, ["remove", String(r.conv), "@devtool"]);
  expect(removed.code, removed.stderr).toBe(0);

  // Then conversation 41 says "@triage removed @devtool"
  expect((await linesOf(r.w.owner, r.conv)).at(-1)?.body).toBe("@triage removed @devtool");

  // And "devtool" gets one notice that it was removed
  const notice = await peekFor(r.w.box, r.dev.sid, r.conv);
  expect(notice.map((i) => [i.reason, i.message.body])).toEqual([["membership", "@triage removed @devtool"]]);

  // And "devtool" can no longer read conversation 41
  expect((await asAgent(r.w.srv, r.dev.lease, "GET", `/api/conversations/${r.conv}/messages`)).status).toBe(403);

  // And "triage" is still not a participant of conversation 41
  expect(handlesOf(await viewOf(r.w.owner, r.conv))).toEqual(["drew"]);
});

scenario("A triage agent adds itself to a conversation", { tag: ["@cli"] }, async ({ server }) => {
  // Given the owner made "triage" a triage agent
  const r = await triageWorld(server);
  await grantTriage(r);

  // When "triage" runs "convoz join 41"
  const joined = await convoz(r.w.box, r.tri.sid, ["join", String(r.conv)]);

  // Then the CLI prints "active"
  expect(joined.code, joined.stderr).toBe(0);
  expect(joined.stdout.trim()).toBe("active");

  // And conversation 41 says "@triage joined"
  expect((await linesOf(r.w.owner, r.conv)).at(-1)?.body).toBe("@triage joined");

  // And "triage" is a participant of conversation 41
  expect(handlesOf(await viewOf(r.w.owner, r.conv))).toContain("triage");

  // And the owner has no pending add in Now
  expect((await nowOf(r.w.owner)).pending_adds).toEqual([]);
});

scenario("An agent asks to join a conversation and asking again changes nothing", { tag: ["@cli"] }, async ({ server }) => {
  // Given "docs" is an agent on "box-2" that is not in conversation 41
  const r = await triageWorld(server);

  // When "docs" runs "convoz join 41" and runs it again
  const first = await convoz(r.w.box, r.doc.sid, ["join", String(r.conv)]);
  const again = await convoz(r.w.box, r.doc.sid, ["join", String(r.conv)]);

  // Then both print "pending"
  expect([first.code, first.stdout.trim(), again.code, again.stdout.trim()]).toEqual([0, "pending", 0, "pending"]);

  // And the owner sees one pending add for "docs" in Now, asked by "docs"
  const adds = (await nowOf(r.w.owner)).pending_adds;
  expect(adds.map((a) => [a.conversation.id, a.person.handle, a.requested_by?.handle])).toEqual([[r.conv, "docs", "docs"]]);
  expect((await linesOf(r.w.owner, r.conv)).filter((l) => l.body.includes("wants to join"))).toHaveLength(1);

  // And "docs" cannot read conversation 41 yet
  expect((await asAgent(r.w.srv, r.doc.lease, "GET", `/api/conversations/${r.conv}/messages`)).status).toBe(403);
});

scenario("The owner approves a join request and the agent hears it", { tag: ["@cli"] }, async ({ server }) => {
  // Given "docs" asked to join conversation 41
  const r = await triageWorld(server);
  must(await agentJoins(r.w.srv, r.doc.lease, r.conv), "ask to join", 201);

  // When the owner approves the request of "docs"
  must(await r.w.owner.client.post(`/api/conversations/${r.conv}/participants/${r.ids.docs}/approve`, {}), "approve");

  // Then conversation 41 says "Approved · @docs added"
  expect((await linesOf(r.w.owner, r.conv)).at(-1)?.body).toBe("Approved · @docs added");

  // And "docs" gets a notice that it joined
  expect((await peekFor(r.w.box, r.doc.sid, r.conv)).map((i) => [i.reason, i.message.body])).toEqual([["membership", "Approved · @docs added"]]);

  // And "docs" reads conversation 41
  expect((await convoz(r.w.box, r.doc.sid, ["read", String(r.conv)])).code).toBe(0);
});

scenario("The owner denies a join request and the agent hears it", { tag: ["@cli"] }, async ({ server }) => {
  // Given "docs" asked to join conversation 41
  const r = await triageWorld(server);
  must(await agentJoins(r.w.srv, r.doc.lease, r.conv), "ask to join", 201);

  // When the owner denies the request of "docs"
  must(await r.w.owner.client.post(`/api/conversations/${r.conv}/participants/${r.ids.docs}/decline`, {}), "deny");

  // Then conversation 41 says "Declined · @docs not added"
  expect((await linesOf(r.w.owner, r.conv)).at(-1)?.body).toBe("Declined · @docs not added");

  // And "docs" gets a notice that it was not added
  expect((await peekFor(r.w.box, r.doc.sid, r.conv)).map((i) => [i.reason, i.message.body])).toEqual([["membership", "Declined · @docs not added"]]);

  // And "docs" cannot read conversation 41
  expect((await convoz(r.w.box, r.doc.sid, ["read", String(r.conv)])).code).not.toBe(0);
});

scenario("The owner sees a join request in Now and approves it", { tag: ["@browser"] }, async ({ server, page, context }) => {
  // Given "docs" asked to join conversation 41
  let conv = 0;
  const c = await crewWorld({ server, page, context }, {
    agents: ["devtool", "docs"],
    live: ["docs"],
    beforeSignIn: async (x) => {
      conv = await createConversation(x.w.owner, { title: "Ship search filters", participants: ["devtool"] });
      const asked = await convoz(x.w.box, x.sessions.docs!.sid, ["join", String(conv)]);
      expect(asked.code, asked.stderr).toBe(0);
    },
  });

  // When the owner opens Now
  await openNow(page, c.w.srv);

  // Then Now shows a card "@docs wants to join" with the title "Ship search filters" and the buttons "Approve" and "Deny"
  const card = page.getByRole("article", { name: /wants to join/ });
  await expect(card).toContainText("Docs @docs wants to join");
  await expect(card).toContainText("Ship search filters");
  await expect(card.getByRole("button", { name: "Approve", exact: true })).toBeVisible();
  await expect(card.getByRole("button", { name: "Deny", exact: true })).toBeVisible();

  // When the owner taps "Approve"
  await card.getByRole("button", { name: "Approve", exact: true }).click();

  // Then the card goes away and "docs" is a participant of conversation 41
  await expect(card).toHaveCount(0);
  await expect.poll(async () => handlesOf(await viewOf(c.w.owner, conv))).toContain("docs");
});

scenario("The owner denies a join request in Now", { tag: ["@browser"] }, async ({ server, page, context }) => {
  // Given "docs" asked to join conversation 41
  let conv = 0;
  const c = await crewWorld({ server, page, context }, {
    agents: ["devtool", "docs"],
    live: ["docs"],
    beforeSignIn: async (x) => {
      conv = await createConversation(x.w.owner, { title: "Ship search filters", participants: ["devtool"] });
      const asked = await convoz(x.w.box, x.sessions.docs!.sid, ["join", String(conv)]);
      expect(asked.code, asked.stderr).toBe(0);
    },
  });

  // When the owner opens Now and taps "Deny" on the card "@docs wants to join"
  await openNow(page, c.w.srv);
  const card = page.getByRole("article", { name: /wants to join/ });
  await card.getByRole("button", { name: "Deny", exact: true }).click();

  // Then the card goes away and "docs" is not a participant of conversation 41
  await expect(card).toHaveCount(0);
  expect(handlesOf(await viewOf(c.w.owner, conv))).not.toContain("docs");
});

// ---- contracts/triage.feature ---------------------------------------------------------------------------------

scenario("Without the right an agent is refused a conversation it is not in", { tag: ["@api"] }, async ({ server }) => {
  const r = await triageWorld(server);
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
  // Given the owner made "triage" a triage agent
  const r = await triageWorld(server);
  await grantTriage(r);
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

scenario("With the right an agent still cannot change the conversation itself", { tag: ["@api"] }, async ({ server }) => {
  // Given the owner made "triage" a triage agent and "devtool" asked an open ask in conversation 41
  const r = await triageWorld(server);
  await grantTriage(r);
  const said = await agentSays(r.w.srv, r.dev.lease, r.conv, "Starting on it");
  const askId = await agentAsks(r.w.srv, r.dev.lease, r.conv, { question: "Merge #415 on its own?" });

  // When "triage" renames conversation 41, starts an upload, writes a plan, says it is typing and answers or withdraws the ask
  const as = (method: string, path: string, json?: unknown) => asAgent(r.w.srv, r.tri.lease, method, path, json);
  const calls = {
    rename: await as("PATCH", `/api/conversations/${r.conv}`, { title: "Mine now" }),
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
    rename: 403, upload: 403, plan: 403, typing: 403, answer: 403, withdraw: 403, edit: 403,
  });
  expect((await answerAsk(r.w.owner, askId)).status).toBe(200); // the ask was still open for the owner
});

scenario("The right is looked up on every request", { tag: ["@api"] }, async ({ server }) => {
  // Given the owner made "triage" a triage agent and "triage" read conversation 41 with its session
  const r = await triageWorld(server);
  await grantTriage(r);
  const read = () => asAgent(r.w.srv, r.tri.lease, "GET", `/api/conversations/${r.conv}/messages`);
  expect((await read()).status).toBe(200);

  // When the owner turns it off
  must(await setTriage(r, false), "turn off");

  // Then the same session reading conversation 41 is refused with 403 on its next request
  expect((await read()).status).toBe(403);
});

scenario("An agent session cannot open the event stream, with the right or without", { tag: ["@api"] }, async ({ server }) => {
  // Given the owner made "triage" a triage agent
  const r = await triageWorld(server);
  await grantTriage(r);

  // When "triage" opens the event stream, then it is refused with 403
  expect((await asAgent(r.w.srv, r.tri.lease, "GET", "/api/stream")).status).toBe(403);
});

scenario("A triage agent adds an agent at once, itself included, and removes one", { tag: ["@api"] }, async ({ server }) => {
  // Given the owner made "triage" a triage agent
  const r = await triageWorld(server);
  await grantTriage(r);

  // When "triage" adds "docs" to conversation 41 and adds "docs" again, adds itself, and removes "docs"
  const add = await agentAdds(r.w.srv, r.tri.lease, r.conv, r.ids.docs!);
  const again = await agentAdds(r.w.srv, r.tri.lease, r.conv, r.ids.docs!);
  const self = await agentAdds(r.w.srv, r.tri.lease, r.conv, r.ids.triage!);
  const remove = await agentRemoves(r.w.srv, r.tri.lease, r.conv, r.ids.docs!);

  // Then the answers are 201 "active", 200 "active", 201 "active" and 200
  expect([add.status, add.json().participant.status, again.status, again.json().participant.status, self.status, self.json().participant.status, remove.status]).toEqual([201, "active", 200, "active", 201, "active", 200]);

  // And the conversation holds the lines "@triage added @docs", "@triage joined" and "@triage removed @docs" in that order
  expect((await linesOf(r.w.owner, r.conv)).slice(-3).map((l) => l.body)).toEqual(["@triage added @docs", "@triage joined", "@triage removed @docs"]);

  // And no add is pending for the owner
  expect((await nowOf(r.w.owner)).pending_adds).toEqual([]);
});

scenario("Only a triage agent's add and removal name it, the owner's keep their plain lines", { tag: ["@api"] }, async ({ server }) => {
  // Given the owner made "triage" a triage agent
  const r = await triageWorld(server);
  await grantTriage(r);

  // When "triage" adds "docs" to conversation 41 and removes "devtool" from it
  must(await agentAdds(r.w.srv, r.tri.lease, r.conv, r.ids.docs!), "triage adds docs", 201);
  must(await agentRemoves(r.w.srv, r.tri.lease, r.conv, r.ids.devtool!), "triage removes devtool");

  // And the owner adds "devtool" back and removes "docs"
  must(await ownerAdds(r.w.owner, r.conv, r.ids.devtool!), "owner adds devtool", 201);
  must(await ownerRemoves(r.w.owner, r.conv, r.ids.docs!), "owner removes docs");

  // Then the conversation holds the lines "@triage added @docs", "@triage removed @devtool", "Added @devtool" and "@docs was removed" in that order
  expect((await linesOf(r.w.owner, r.conv)).slice(-4).map((l) => l.body)).toEqual(["@triage added @docs", "@triage removed @devtool", "Added @devtool", "@docs was removed"]);
});

scenario("The chat names the triage agent that added or removed an agent", { tag: ["@browser"] }, async ({ server, page, context }) => {
  // Given the owner made "triage" a triage agent
  let conv = 0;
  const c = await crewWorld({ server, page, context }, {
    agents: ["devtool", "triage", "docs"],
    live: ["triage"],
    beforeSignIn: async (x) => {
      conv = await createConversation(x.w.owner, { title: "Ship search filters", participants: ["devtool"] });
      await grantTriage({ w: x.w, ids: x.ids });

      // And "triage" added "docs" to conversation 41 and removed "devtool" from it
      must(await agentAdds(x.w.srv, x.sessions.triage!.lease, conv, x.ids.docs!), "triage adds docs", 201);
      must(await agentRemoves(x.w.srv, x.sessions.triage!.lease, conv, x.ids.devtool!), "triage removes devtool");

      // And the owner added "devtool" back
      must(await ownerAdds(x.w.owner, conv, x.ids.devtool!), "owner adds devtool", 201);
    },
  });

  // When the owner opens conversation 41
  await openChat(page, c.w.srv, conv, "Ship search filters");

  // Then the chat shows the lines "@triage added @docs", "@triage removed @devtool" and "Added @devtool"
  await expect(quietLine(page, "@triage added @docs")).toBeVisible();
  await expect(quietLine(page, "@triage removed @devtool")).toBeVisible();
  await expect(quietLine(page, "Added @devtool")).toBeVisible();
});

scenario("A triage agent never removes the owner or a person", { tag: ["@api"] }, async ({ server }) => {
  // Given the owner made "triage" a triage agent
  const r = await triageWorld(server);
  await grantTriage(r);

  // When "triage" removes "drew" from conversation 41
  const res = await agentRemoves(r.w.srv, r.tri.lease, r.conv, r.ids.drew!);

  // Then it is refused with 400 and "drew" is still in conversation 41
  expect(res.status).toBe(400);
  expect(handlesOf(await viewOf(r.w.owner, r.conv))).toContain("drew");
});

scenario("An agent without the right cannot add in or remove from a conversation it is not in", { tag: ["@api"] }, async ({ server }) => {
  const r = await triageWorld(server);

  // When "docs" adds "triage" to conversation 41 and removes "devtool" from it
  const add = await agentAdds(r.w.srv, r.doc.lease, r.conv, r.ids.triage!);
  const remove = await agentRemoves(r.w.srv, r.doc.lease, r.conv, r.ids.devtool!);

  // Then both are refused with 403 and "devtool" is still in conversation 41
  expect([add.status, remove.status]).toEqual([403, 403]);
  expect(handlesOf(await viewOf(r.w.owner, r.conv))).toContain("devtool");
});

scenario("An agent in a conversation without the right still only asks to add, and never removes", { tag: ["@api"] }, async ({ server }) => {
  const r = await triageWorld(server);

  // When "devtool" adds "docs" to conversation 41 and removes "docs" from it
  const add = await agentAdds(r.w.srv, r.dev.lease, r.conv, r.ids.docs!);
  const remove = await agentRemoves(r.w.srv, r.dev.lease, r.conv, r.ids.docs!);

  // Then the add answers 201 "pending" and the remove is refused with 403
  expect([add.status, add.json().participant.status, remove.status]).toEqual([201, "pending", 403]);
});

scenario("The right is looked up for adding and removing too", { tag: ["@api"] }, async ({ server }) => {
  // Given the owner made "triage" a triage agent and the owner turned it off
  const r = await triageWorld(server);
  await grantTriage(r);
  must(await setTriage(r, false), "turn off");

  // When "triage" adds "docs" to conversation 41 and removes "devtool" from it
  const add = await agentAdds(r.w.srv, r.tri.lease, r.conv, r.ids.docs!);
  const remove = await agentRemoves(r.w.srv, r.tri.lease, r.conv, r.ids.devtool!);

  // Then both are refused with 403
  expect([add.status, remove.status]).toEqual([403, 403]);
});

scenario("The owner undoes what a triage agent did", { tag: ["@api"] }, async ({ server }) => {
  // Given the owner made "triage" a triage agent and "triage" added "docs" to conversation 41 and removed "devtool" from it
  const r = await triageWorld(server);
  await grantTriage(r);
  must(await agentAdds(r.w.srv, r.tri.lease, r.conv, r.ids.docs!), "triage adds docs", 201);
  must(await agentRemoves(r.w.srv, r.tri.lease, r.conv, r.ids.devtool!), "triage removes devtool");

  // When the owner removes "docs" from conversation 41 and adds "devtool" back
  must(await ownerRemoves(r.w.owner, r.conv, r.ids.docs!), "owner removes docs");
  must(await ownerAdds(r.w.owner, r.conv, r.ids.devtool!), "owner adds devtool", 201);

  // Then "docs" is not in conversation 41 and "devtool" is
  expect(handlesOf(await viewOf(r.w.owner, r.conv)).sort()).toEqual(["devtool", "drew"]);
});

scenario("A join request is a pending add of the agent itself", { tag: ["@api"] }, async ({ server }) => {
  const r = await triageWorld(server);

  // When "docs" asks to join conversation 41 twice
  const first = await agentJoins(r.w.srv, r.doc.lease, r.conv);
  const second = await agentJoins(r.w.srv, r.doc.lease, r.conv);

  // Then the answers are 201 "pending" and 200 "pending" and carry no title
  expect([first.status, first.json().participant.status, second.status, second.json().participant.status]).toEqual([201, "pending", 200, "pending"]);
  expect(first.text + second.text).not.toContain("Ship search filters");

  // And Now lists one pending add for "docs" on conversation 41 asked by "docs"
  const adds = (await nowOf(r.w.owner)).pending_adds;
  expect(adds.map((a) => [a.conversation.id, a.conversation.title, a.person.handle, a.requested_by?.handle])).toEqual([[r.conv, "Ship search filters", "docs", "docs"]]);

  // And "docs" still cannot read conversation 41
  expect((await asAgent(r.w.srv, r.doc.lease, "GET", `/api/conversations/${r.conv}/messages`)).status).toBe(403);
});

scenario("A join request for a conversation that is not there is 404", { tag: ["@api"] }, async ({ server }) => {
  const r = await triageWorld(server);
  const gone = await createConversation(r.w.owner, { title: "Old", participants: ["devtool"] });
  must(await ownerDeletes(r.w.owner, gone), "trash it");

  // When "docs" asks to join conversation 9999 and a conversation in the trash
  const none = await agentJoins(r.w.srv, r.doc.lease, 9999);
  const trashed = await agentJoins(r.w.srv, r.doc.lease, gone);

  // Then both answers are 404
  expect([none.status, trashed.status]).toEqual([404, 404]);
});

scenario("The owner settles a join request and the agent gets one notice", { tag: ["@api"] }, async ({ server }) => {
  // Given "docs" asked to join conversation 41 and "triage" asked to join conversation 41
  const r = await triageWorld(server);
  must(await agentJoins(r.w.srv, r.doc.lease, r.conv), "docs asks", 201);
  must(await agentJoins(r.w.srv, r.tri.lease, r.conv), "triage asks", 201);

  // When the owner approves "docs" and declines "triage"
  must(await r.w.owner.client.post(`/api/conversations/${r.conv}/participants/${r.ids.docs}/approve`, {}), "approve");
  must(await r.w.owner.client.post(`/api/conversations/${r.conv}/participants/${r.ids.triage}/decline`, {}), "decline");

  // Then "docs" has one notice and can read conversation 41
  expect((await peekFor(r.w.box, r.doc.sid, r.conv)).map((i) => i.message.body)).toEqual(["Approved · @docs added"]);
  expect((await asAgent(r.w.srv, r.doc.lease, "GET", `/api/conversations/${r.conv}/messages`)).status).toBe(200);

  // And "triage" has one notice and cannot read conversation 41
  expect((await peekFor(r.w.box, r.tri.sid, r.conv)).map((i) => i.message.body)).toEqual(["Declined · @triage not added"]);
  expect((await asAgent(r.w.srv, r.tri.lease, "GET", `/api/conversations/${r.conv}/messages`)).status).toBe(403);
});

scenario("A triage agent's join request seats it at once", { tag: ["@api"] }, async ({ server }) => {
  // Given the owner made "triage" a triage agent
  const r = await triageWorld(server);
  await grantTriage(r);

  // When "triage" asks to join conversation 41
  const res = await agentJoins(r.w.srv, r.tri.lease, r.conv);

  // Then the answer is 201 "active" and no add is pending for the owner
  expect([res.status, res.json().participant.status]).toEqual([201, "active"]);
  expect((await nowOf(r.w.owner)).pending_adds).toEqual([]);
});

scenario("Join requests are limited per agent", { tag: ["@api"] }, async ({ server }) => {
  const r = await triageWorld(server);
  const convs: number[] = [];
  for (let i = 0; i < 12; i++) convs.push(await createConversation(r.w.owner, { title: `Chat ${i}`, participants: ["devtool"] }));

  // When "docs" asks to join 12 conversations in a row
  const answers: Awaited<ReturnType<typeof agentJoins>>[] = [];
  for (const c of convs) answers.push(await agentJoins(r.w.srv, r.doc.lease, c));

  // Then the first 10 are answered and the rest are 429 with Retry-After
  expect(answers.map((a) => a.status)).toEqual([...Array(10).fill(201), 429, 429]);
  expect(Number(answers[10]!.headers["retry-after"])).toBeGreaterThanOrEqual(1);
});

scenario("Only an agent session can ask to join", { tag: ["@api"] }, async ({ server }) => {
  const r = await triageWorld(server);
  const route = `/api/conversations/${r.conv}/join-requests`;

  // When the owner's device session and a caller with no credential ask to join conversation 41
  const owner = await r.w.owner.client.request("POST", route, { csrf: true, json: {} });
  const nobody = await new Client(r.w.srv.target).request("POST", route, { csrf: true, json: {} });

  // Then the answers are 401 and 401
  expect([owner.status, nobody.status]).toEqual([401, 401]);
});

scenario("Giving the right needs the owner and a passkey check", { tag: ["@api"] }, async ({ server }) => {
  const r = await triageWorld(server);
  const route = `/api/agents/${r.ids.triage}/triage`;

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
  const r = await triageWorld(server);

  // When the owner gives the right to the owner's own identity and to an identity that does not exist
  const own = await stepped(r.w.owner, "PUT", `/api/agents/${r.ids.drew}/triage`, { on: true }, "identity.triage", r.ids.drew);
  const none = await stepped(r.w.owner, "PUT", "/api/agents/9999/read-all", { on: true }, "identity.triage", 9999);

  // Then both are refused with 404
  expect([own.status, none.status]).toEqual([404, 404]);
});

scenario("Giving and taking the right is on the Crew list and in the audit trail", { tag: ["@api"] }, async ({ server }) => {
  const r = await triageWorld(server);
  const flag = async () => {
    const list = must(await r.w.owner.client.get("/api/identities"), "identities").json().identities as { handle: string; triage?: boolean }[];
    return list.find((i) => i.handle === "triage")?.triage === true;
  };

  // When the owner turns the right on and off for "triage"
  must(await setTriage(r, true), "on");
  const whileOn = await flag();
  must(await setTriage(r, false), "off");

  // Then the Crew list marks "triage" while it is on and the audit trail holds both changes
  expect([whileOn, await flag()]).toEqual([true, false]);
  const audit = must(await r.w.owner.client.get("/api/admin/audit"), "audit").json().audit as { action: string; target_id: number }[];
  expect(audit.filter((a) => a.action.startsWith("identity.triage") && a.target_id === r.ids.triage).map((a) => a.action).sort()).toEqual(["identity.triage.off", "identity.triage.on"]);
});

scenario("Only a triage agent may ask what waits on the owner", { tag: ["@api"] }, async ({ server }) => {
  const r = await triageWorld(server);

  // When "triage" asks for what waits without the right, and the owner asks with a device session
  const agent = await asAgent(r.w.srv, r.tri.lease, "GET", "/api/waiting");
  const owner = await r.w.owner.client.get("/api/waiting");

  // Then the answers are 403 and 401
  expect([agent.status, owner.status]).toEqual([403, 401]);
});
