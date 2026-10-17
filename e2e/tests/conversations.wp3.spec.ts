import { composer, isBold, message, sendButton, unreadDot } from "../lib/chat-ui.ts";
import { sidOf } from "../lib/cli.ts";
import { agentSays, convoz, createConversation, listConversations, messagesOf, ownerPost, ownerReads, ownerSays, peekFor, unreadOf } from "../lib/chat.ts";
import { expect, scenario } from "../lib/scenario.ts";
import { must, signIn } from "../lib/owner.ts";
import { send } from "../lib/http.ts";
import {
  askState,
  browserWorld,
  detailsPanel,
  openChat,
  rowsOnList,
  seedAsk,
  seedDb,
  showDetails,
  agentCreates,
  asAgent,
  handlesOf,
  idsOf,
  machineWith,
  ownerAdds,
  ownerRemoves,
  seedReply,
  startSession,
  unreadFor,
  viewOf,
  world,
} from "../lib/wp3.ts";

/*
 * WP3: conversations, participants, pickup and trash (specs/features/conversations.feature and specs/contracts/conversations.feature).
 * Routes (design §13): POST /api/conversations/:id/participants {identity_id|handle, history: since_now|full} (a person adds at once, an
 * agent only asks: "pending"), POST .../participants/:iid/{approve,decline}, DELETE .../participants/:iid, POST .../leave, POST .../resume,
 * POST .../pickup/open, POST .../pickup (lease with the pickup scope), PATCH|DELETE /api/conversations/:id, POST .../restore and
 * GET /api/conversations?deleted=1 (the trash). An agent that may not see a conversation is told 403 (the CLI exits 3), a person 404.
 * A visibility floor is the newest message id the reader may NOT see; a person who joins "since now" gets the id of the line that says so.
 */

// ---- Rule: Agents join only through a human, and see only from their join --------------------------------------

scenario("Events from before an agent joined are not replayed to it", { tag: ["@api"] }, async ({ server }) => {
  // Given "docs" joined conversation 41 after 10 events in it
  const w = await world(server);
  const ids = await idsOf(w.owner);
  const conv = await createConversation(w.owner, { title: "Ship search filters", participants: ["devtool"] });
  for (let i = 1; i <= 10; i++) await ownerSays(w.owner, conv, `before ${i}`);
  must(await ownerAdds(w.owner, conv, ids.docs!), "add docs", 201);
  const docs = await startSession(w.box, "docs", "docs");

  // When "docs" reads the conversation and its inbox
  const read = await asAgent(w.srv, docs.lease, "GET", `/api/conversations/${conv}/messages`);
  const items = await peekFor(w.box, docs.sid, conv);

  // Then it receives nothing from those 10 events
  expect(read.status).toBe(200);
  expect(read.json().messages).toEqual([]);
  expect(items).toEqual([]);

  // And what happens after the join reaches it
  await ownerSays(w.owner, conv, "after the join");
  expect((await asAgent(w.srv, docs.lease, "GET", `/api/conversations/${conv}/messages`)).json().messages.map((m: { body: string }) => m.body)).toEqual(["after the join"]);
  expect((await peekFor(w.box, docs.sid, conv)).map((i) => i.reason)).toEqual(["activity"]);
});

scenario("An agent that creates a conversation cannot pull others in", { tag: ["@api"] }, async ({ server }) => {
  // When "devtool" creates conversation "Release prep" listing "@docs" and "@release-bot"
  const w = await world(server);
  const ids = await idsOf(w.owner);
  const dev = await startSession(w.box, "devtool", "devtool");
  const docs = await startSession(w.box, "docs", "docs");
  const bot = await startSession(w.box, "release-bot", "release-bot");
  const made = must(await agentCreates(w.srv, dev.lease, { title: "Release prep", participants: ["docs", "release-bot"] }), "agent creates", 201);
  const conv = made.json().conversation.id as number;

  // Then the owner sees 2 pending adds in Now for "Release prep"
  const view = await viewOf(w.owner, conv);
  expect(view.title).toBe("Release prep");
  expect(view.pending?.map((p) => p.person.handle)).toEqual(["docs", "release-bot"]);
  expect(view.pending?.every((p) => p.requested_by?.handle === "devtool")).toBe(true);
  expect(handlesOf(view)).toEqual(["devtool"]);

  // And "docs" and "release-bot" get 403 on "convoz read" until the owner approves
  for (const who of [docs, bot]) expect((await convoz(w.box, who.sid, ["read", String(conv)])).code).toBe(3);
  must(await w.owner.client.post(`/api/conversations/${conv}/participants/${ids.docs}/approve`), "approve docs");
  expect((await convoz(w.box, docs.sid, ["read", String(conv)])).code).toBe(0);
  expect((await convoz(w.box, bot.sid, ["read", String(conv)])).code).toBe(3);
});

scenario("An agent sees a reply under a hidden root as a stub", { tag: ["@cli"] }, async ({ server, dataDir }) => {
  // Given "docs" was added to conversation 41 after thread root 900 was posted
  const w = await world(server, { plaintext: true });
  const ids = await idsOf(w.owner);
  const conv = await createConversation(w.owner, { title: "Ship search filters", participants: ["devtool"] });
  const root = await ownerSays(w.owner, conv, "The thread root");
  must(await ownerAdds(w.owner, conv, ids.docs!), "add docs", 201);
  const docs = await startSession(w.box, "docs", "docs");

  // And the owner replies in thread 900 after the add
  seedReply(dataDir, conv, root, ids.drew!, "The reply after the add");

  // When "docs" runs "convoz read 41 --thread 900"
  const res = await convoz(w.box, docs.sid, ["read", String(conv), "--thread", String(root)]);

  // Then it sees the reply and a stub "earlier message not shown" for the root
  expect(res.code, res.stderr).toBe(0);
  expect(res.stdout).toContain("The reply after the add");
  expect(res.stdout).toContain("earlier message not shown");
  expect(res.stdout).not.toContain("The thread root");
});

// ---- Rule: Removing an agent cuts it off in one step (AC-6) ---------------------------------------------------

scenario("A removed agent sees nothing of the conversation", { tag: ["@cli"] }, async ({ server }) => {
  // Given the owner removed "devtool" from conversation 41
  const w = await world(server);
  const ids = await idsOf(w.owner);
  const conv = await createConversation(w.owner, { title: "Ship search filters", participants: ["devtool"] });
  const dev = await startSession(w.box, "devtool", "devtool");
  await ownerSays(w.owner, conv, "Is the build green?");
  expect((await convoz(w.box, dev.sid, ["read", String(conv)])).code).toBe(0);
  must(await ownerRemoves(w.owner, conv, ids.devtool!), "remove devtool");

  // When "devtool" runs "convoz read 41"
  const res = await convoz(w.box, dev.sid, ["read", String(conv)]);

  // Then the CLI exits 3
  expect(res.code).toBe(3);
  expect(res.stdout).not.toContain("Is the build green?");
});

// ---- contracts: Read position is honest (DA-2, DA-4) ------------------------------------------------------------

scenario("An agent post keeps an earlier human message unread for that agent", { tag: ["@api"] }, async ({ server }) => {
  // Given "devtool" read conversation 41 up to message 100
  const w = await world(server);
  const conv = await createConversation(w.owner, { title: "Ship search filters", participants: ["devtool"] });
  const dev = await startSession(w.box, "devtool", "devtool");
  const before = await ownerSays(w.owner, conv, "first");
  must(await asAgent(w.srv, dev.lease, "POST", `/api/conversations/${conv}/read`, { main_id: before }), "agent reads");

  // And the owner posted message 101
  await ownerSays(w.owner, conv, "second, from the owner");

  // When "devtool" posts message 102
  await agentSays(w.srv, dev.lease, conv, "third, from the agent");

  // Then GET /api/conversations as "devtool" shows 1 unread for conversation 41
  expect(await unreadFor(w.srv, dev.lease, conv)).toBe(1);
});

scenario("A read position never moves backward", { tag: ["@api"] }, async ({ server }) => {
  // Given the owner read conversation 41 up to message 120
  const w = await world(server);
  const conv = await createConversation(w.owner, { title: "Ship search filters", participants: ["devtool"] });
  const dev = await startSession(w.box, "devtool", "devtool");
  const old = await agentSays(w.srv, dev.lease, conv, "old");
  const newest = await agentSays(w.srv, dev.lease, conv, "newest");
  await ownerReads(w.owner, conv, newest);
  expect(await unreadOf(w.owner, conv)).toBe(0);

  // When an old tab reports a read position of message 90
  const stale = await w.owner.client.post(`/api/conversations/${conv}/read`, { main_id: old });
  expect(stale.status).toBe(200);
  await agentSays(w.srv, dev.lease, conv, "later");

  // Then the owner's read position is still message 120
  expect(await unreadOf(w.owner, conv)).toBe(1);
});

// ---- contracts: A conversation can be offered to any agent for pickup (SEC-6) -------------------------------------

scenario("An agent without the pickup scope cannot pick up", { tag: ["@api"] }, async ({ server }) => {
  // Given the owner opened conversation 60 for pickup
  const w = await world(server);
  const conv = await createConversation(w.owner, { title: "Weekly usage", participants: [] });
  must(await w.owner.client.post(`/api/conversations/${conv}/pickup/open`), "open for pickup");
  const dev = await startSession(w.box, "devtool", "devtool");

  // When "devtool" on a machine without the pickup scope picks it up
  const res = await asAgent(w.srv, dev.lease, "POST", `/api/conversations/${conv}/pickup`, {});

  // Then the server answers 403
  expect(res.status).toBe(403);
  expect((await viewOf(w.owner, conv)).pickup).toBe("open");
});

scenario("A stale pickup holder cannot act after a release", { tag: ["@api"] }, async ({ server }) => {
  // Given "devtool" picked up conversation 60 and the pickup was released when its machine was revoked
  const w = await world(server, { pickup: true });
  const ids = await idsOf(w.owner);
  const conv = await createConversation(w.owner, { title: "Weekly usage", participants: [] });
  must(await w.owner.client.post(`/api/conversations/${conv}/pickup/open`), "open for pickup");
  const dev = await startSession(w.box, "devtool", "devtool");
  const taken = must(await asAgent(w.srv, dev.lease, "POST", `/api/conversations/${conv}/pickup`, {}), "devtool picks up");
  const oldFence = taken.json().fence as number;
  expect(oldFence).toBeGreaterThanOrEqual(1);
  const renewed = await asAgent(w.srv, dev.lease, "POST", `/api/conversations/${conv}/pickup`, { fence: oldFence });
  expect(renewed.status).toBe(200);
  const { stepped } = await import("../lib/machines.ts");
  must(await stepped(w.owner, "POST", `/api/machines/${w.box2.id}/revoke`, {}, "machine.revoke", w.box2.id), "revoke box-2");

  // And "docs" picked it up next
  const other = await machineWith(w.srv, w.owner, "laptop-1", ["docs"]);
  const docs = await startSession(other.box, "docs", "docs");
  const next = must(await asAgent(w.srv, docs.lease, "POST", `/api/conversations/${conv}/pickup`, {}), "docs picks up");
  expect(next.json().fence).toBeGreaterThan(oldFence);

  // When the old "devtool" pickup sends a pickup-only action with its old fence
  const stale = await asAgent(w.srv, docs.lease, "POST", `/api/conversations/${conv}/pickup`, { fence: oldFence });

  // Then the server answers 409
  expect(stale.status).toBe(409);
  expect(stale.json().error.code).toBe("stale_fence");
  expect(ids.docs).toBeGreaterThan(0);
});

// ---- contracts: The owner starts and names conversations ------------------------------------------------------

scenario("An agent creates at most 20 conversations a day", { tag: ["@api"] }, async ({ server }) => {
  // Given "devtool" created 20 conversations today
  const w = await world(server);
  const dev = await startSession(w.box, "devtool", "devtool");
  for (let i = 1; i <= 20; i++) must(await agentCreates(w.srv, dev.lease, { title: `Conversation ${i}` }), `create ${i}`, 201);

  // When it creates another
  const res = await agentCreates(w.srv, dev.lease, { title: "One too many" });

  // Then the server answers 429
  expect(res.status).toBe(429);
  expect(Number(res.headers["retry-after"])).toBeGreaterThan(0);
  expect((await listConversations(w.owner)).filter((c) => c.title === "One too many")).toEqual([]);
});

scenario("A send that races the cleanup keeps the conversation", { tag: ["@api"] }, async ({ server, testApi }) => {
  // Given an empty conversation that is 24 hours old
  const w = await world(server);
  const empty = await createConversation(w.owner, { participants: ["devtool"] });
  const other = await createConversation(w.owner, { participants: ["devtool"] });
  await testApi(w.srv).advanceClock((24 * 60 + 1) * 60_000);
  await signIn(w.owner.client, w.owner.soft);

  // When the owner sends "wait" at the moment the cleanup runs
  must(await ownerPost(w.owner, empty, "wait"), "send wait", 201);
  must(await send(w.srv.target, "POST", "/__test/maintenance", { json: {} }), "cleanup");

  // Then the conversation exists with the message "wait"
  expect((await messagesOf(w.owner, empty)).map((m) => m.body)).toEqual(["wait"]);
  expect((await viewOf(w.owner, empty)).id).toBe(empty);

  // And a conversation nobody wrote in is gone
  expect((await w.owner.client.get(`/api/conversations/${other}`)).status).toBe(404);
});

// ---- Rule: The owner starts and names conversations (browser) ------------------------------------------------------

scenario("The details sidebar shows who is here and how the conversation is set", { tag: ["@browser"] }, async ({ server, page, context }) => {
  // Given conversation 41 with "devtool" and "docs"
  const w = await browserWorld({ server, page, context });
  const conv = await createConversation(w.owner, { title: "Ship search filters", participants: ["devtool", "docs"] });
  must(await w.owner.client.request("PATCH", `/api/conversations/${conv}`, { csrf: true, json: { link_url: "https://github.com/acme/convoz/pull/412" } }), "link the pull request");
  await openChat(page, w.srv, conv, "Ship search filters");

  // When the owner presses "I"
  const panel = await showDetails(page);

  // Then the details show the participants, "Started by", "Created", "Muted" and the linked pull request
  await expect(panel.getByRole("list", { name: "Participants" }).getByRole("listitem")).toHaveText([/Drew/, /@devtool/, /@docs/]);
  const row = (label: string) => panel.locator("dt", { hasText: label }).locator("xpath=following-sibling::dd[1]");
  await expect(row("Started by")).toHaveText("Drew");
  await expect(row("Created")).not.toBeEmpty();
  await expect(row("Muted")).toHaveText("No");
  await expect(row("Pull request").getByRole("link")).toHaveAttribute("href", "https://github.com/acme/convoz/pull/412");
});

scenario("The owner renames a conversation", { tag: ["@browser"] }, async ({ server, page, context }) => {
  // Given conversation 41 "Plan the search filters launch"
  const w = await browserWorld({ server, page, context }, { live: ["devtool"] });
  const conv = await createConversation(w.owner, { title: "Plan the search filters launch", participants: ["devtool"] });
  await openChat(page, w.srv, conv, "Plan the search filters launch");

  // When the owner renames it to "Ship search filters"
  const panel = await showDetails(page);
  await panel.getByRole("button", { name: "Rename", exact: true }).click();
  const sheet = page.getByRole("dialog", { name: "Rename conversation" });
  await sheet.getByRole("textbox", { name: "Title" }).fill("Ship search filters");
  await sheet.getByRole("button", { name: "Save" }).click();

  // Then the rail and the header show "Ship search filters"
  await expect(page.getByRole("heading", { name: "Ship search filters", level: 1 })).toBeVisible();
  await page.goto(`${w.srv.origin}/chats`);
  await expect(rowsOnList(page)).toHaveText([/Ship search filters/]);

  // And later messages never change the title
  await agentSays(w.srv, w.sessions.devtool!.lease, conv, "A later message that would have been a title");
  expect((await listConversations(w.owner)).map((c) => c.title)).toEqual(["Ship search filters"]);
});

scenario("An empty untitled conversation is cleaned up after 24 hours", { tag: ["@browser"] }, async ({ server, page, context, testApi }) => {
  // Given the owner started a conversation and sent nothing
  const w = await browserWorld({ server, page, context });
  await createConversation(w.owner, { participants: ["devtool"] });
  await page.goto(`${w.srv.origin}/chats`);
  await expect(rowsOnList(page)).toHaveCount(1);

  // When the test clock moves 24 hours and 1 minute
  await testApi(w.srv).advanceClock((24 * 60 + 1) * 60_000);

  // Then the rail no longer shows it
  await page.reload();
  await expect(rowsOnList(page)).toHaveCount(0);
  await expect(page.getByText(/no chats yet/i)).toBeVisible();
});

scenario("A starred or renamed empty conversation is kept", { tag: ["@browser"] }, async ({ server, page, context, testApi, dataDir }) => {
  // Given the owner started two conversations, starred one, renamed the other and sent nothing
  const w = await browserWorld({ server, page, context }, { plaintext: true });
  const ids = await idsOf(w.owner);
  const starred = await createConversation(w.owner, { participants: ["devtool"] });
  const renamed = await createConversation(w.owner, { participants: ["devtool"] });
  const gone = await createConversation(w.owner, { participants: ["devtool"] });
  must(await w.owner.client.request("PATCH", `/api/conversations/${renamed}`, { csrf: true, json: { title: "Kept by its name" } }), "rename");
  seedDb(dataDir, (db) =>
    db.prepare("INSERT INTO conversation_prefs (identity_id, conversation_id, starred_at, updated_at) VALUES (?, ?, ?, ?)").run(ids.drew!, starred, Date.now(), Date.now()),
  );

  // When the test clock moves 25 hours
  await testApi(w.srv).advanceClock(25 * 3_600_000);

  // Then the rail still shows both
  await page.goto(`${w.srv.origin}/chats`);
  await expect(rowsOnList(page)).toHaveCount(2);
  await expect(rowsOnList(page).filter({ hasText: "Kept by its name" })).toHaveCount(1);
  expect((await w.owner.client.get(`/api/conversations/${gone}`)).status).toBe(404);
});

// ---- Rule: Agents join only through a human, and see only from their join (browser) -------------------------------

scenario("Mentioning an agent adds it at once", { tag: ["@browser"] }, async ({ server, page, context }) => {
  // Given conversation 41 with only the owner
  const w = await browserWorld({ server, page, context }, { live: ["devtool"] });
  const conv = await createConversation(w.owner, { title: "Ship search filters", participants: [] });
  await openChat(page, w.srv, conv, "Ship search filters");

  // When the owner sends "@devtool please look at #412"
  await composer(page).fill("@devtool please look at #412");
  await sendButton(page).click();
  await expect(message(page, "please look at #412")).toBeVisible();

  // Then the participants show "devtool"
  const panel = await showDetails(page);
  await expect(panel.getByRole("list", { name: "Participants" }).getByRole("listitem")).toHaveText([/Drew/, /@devtool/]);

  // And "devtool" gets a mention item
  const items = await peekFor(w.box, w.sessions.devtool!.sid, conv);
  expect(items.map((i) => i.reason)).toEqual(["mention"]);
  expect(items[0]!.message.body).toBe("@devtool please look at #412");
});

scenario("Adding an agent sets what history it sees", { tag: ["@browser"] }, async ({ server, page, context }) => {
  // Given conversation 41 with 20 messages
  const w = await browserWorld({ server, page, context }, { live: ["docs"] });
  const ids = await idsOf(w.owner);
  const examples = [
    { history: "since now", radio: /^Since now/, seen: (bodies: string[]) => expect(bodies).toEqual(["after the add"]) },
    {
      history: "full",
      radio: /^Full history/,
      seen: (bodies: string[]) => expect(bodies.filter((b) => b.startsWith("message "))).toHaveLength(20),
    },
  ];
  for (const ex of examples) {
    const conv = await createConversation(w.owner, { title: `History ${ex.history}`, participants: ["devtool"] });
    for (let i = 1; i <= 20; i++) await ownerSays(w.owner, conv, `message ${i}`);

    // When the owner adds "docs" with history "<history>"
    await openChat(page, w.srv, conv, `History ${ex.history}`);
    const panel = await showDetails(page);
    await panel.getByRole("button", { name: "+ Add" }).click();
    const sheet = page.getByRole("dialog", { name: "Add agent" });
    await sheet.getByRole("list", { name: "Agents to add" }).getByRole("button", { name: /@docs/ }).click();
    await sheet.getByRole("radio", { name: ex.radio }).check();
    await sheet.getByRole("button", { name: "Add @docs" }).click();
    await expect(panel.getByRole("list", { name: "Participants" }).getByRole("listitem")).toHaveText([/Drew/, /@devtool/, /@docs/]);
    await ownerSays(w.owner, conv, "after the add");

    // Then "docs" runs "convoz read 41" and sees <seen>
    const read = await convoz(w.box, w.sessions.docs!.sid, ["read", "--json", String(conv)]);
    expect(read.code, read.stderr).toBe(0);
    const bodies = (JSON.parse(read.stdout).messages as { body: string; author: { kind: string } }[]).filter((m) => m.author.kind !== "system").map((m) => m.body);
    ex.seen(bodies);

    // And "docs" has no unread messages in conversation 41
    expect(await unreadFor(w.srv, w.sessions.docs!.lease, conv)).toBe(0);
  }
  expect(ids.docs).toBeGreaterThan(0);
});

scenario("A removed agent gets nothing more from that conversation", { tag: ["@browser", "@cli"] }, async ({ server, page, context, dataDir }) => {
  // Given "devtool" is in conversations 41 and 52 and waits with "convoz inbox --wait 60"
  const w = await browserWorld({ server, page, context }, { live: ["devtool"], plaintext: true });
  const ids = await idsOf(w.owner);
  const c41 = await createConversation(w.owner, { title: "Ship search filters", participants: ["devtool"] });
  const c52 = await createConversation(w.owner, { title: "Deploy alerts runbook", participants: ["devtool"] });
  const dev = w.sessions.devtool!;
  const waiting = w.box.start(["inbox", "--json", "--sid", dev.sid, "--timeout", "70s", "--wait", "60"], { timeoutMs: 90_000 });

  // And "devtool" has an open ask and a dismissed ask in conversation 41
  const open = seedAsk(dataDir, c41, ids.devtool!, ids.drew!, "Deploy to production?", "open");
  const dismissed = seedAsk(dataDir, c41, ids.devtool!, ids.drew!, "Rename the flag?", "dismissed");
  await openChat(page, w.srv, c41, "Ship search filters");

  // When the owner removes "devtool" from conversation 41
  const panel = await showDetails(page);
  await panel.getByRole("button", { name: "Remove @devtool" }).click();

  // Then conversation 41 shows the system line "@devtool was removed"
  await expect(page.getByRole("log", { name: "Messages" }).getByText("@devtool was removed")).toBeVisible();

  // And both asks show "Closed"
  await expect(page.getByRole("log", { name: "Messages" }).getByText("Closed", { exact: true })).toHaveCount(2);
  expect(askState(dataDir, open)).toEqual({ state: "closed", close_reason: "removed" });
  expect(askState(dataDir, dismissed)).toEqual({ state: "closed", close_reason: "removed" });

  // And "devtool" gets one notice that it was removed, then nothing from conversation 41: no item, no read and no search result
  const done = await waiting.done;
  expect(done.code, done.stderr).toBe(0);
  const notice = JSON.parse(done.stdout).items as { id: number; claim_token: string; reason: string; conversation: { id: number }; message: { body: string } }[];
  expect(notice.map((i) => [i.reason, i.conversation.id, i.message.body])).toEqual([["membership", c41, "@devtool was removed"]]);
  const acked = await convoz(w.box, dev.sid, ["ack", `${notice[0]!.id}:${notice[0]!.claim_token}`]);
  expect(acked.code, acked.stderr).toBe(0);
  await ownerSays(w.owner, c41, "Anyone there?");
  expect((await peekFor(w.box, dev.sid, c41)).map((i) => i.reason)).toEqual([]);
  expect((await convoz(w.box, dev.sid, ["read", String(c41)])).code).toBe(3);

  // And new messages in conversation 52 still reach "devtool"
  await ownerSays(w.owner, c52, "Still listening?");
  expect((await peekFor(w.box, dev.sid, c52)).map((i) => i.message.body)).toEqual(["Still listening?"]);
});

scenario("Adding an agent back offers the original history", { tag: ["@browser"] }, async ({ server, page, context }) => {
  // Given the owner removed "devtool" from conversation 41
  const w = await browserWorld({ server, page, context });
  const ids = await idsOf(w.owner);
  const conv = await createConversation(w.owner, { title: "Ship search filters", participants: ["devtool"] });
  await ownerSays(w.owner, conv, "Is the build green?");
  must(await ownerRemoves(w.owner, conv, ids.devtool!), "remove devtool");
  await openChat(page, w.srv, conv, "Ship search filters");

  // When the owner adds "devtool" again
  const panel = await showDetails(page);
  await panel.getByRole("button", { name: "+ Add" }).click();
  const sheet = page.getByRole("dialog", { name: "Add agent" });
  await sheet.getByRole("list", { name: "Agents to add" }).getByRole("button", { name: /@devtool/ }).click();

  // Then the add sheet offers "since now" and "full history"
  await expect(sheet.getByRole("radio", { name: /since now/i })).toBeVisible();
  await expect(sheet.getByRole("radio", { name: /full history/i })).toBeVisible();
  await sheet.getByRole("radio", { name: /full history/i }).check();
  await sheet.getByRole("button", { name: "Add @devtool" }).click();
  await expect(panel.getByRole("list", { name: "Participants" }).getByRole("listitem")).toHaveText([/Drew/, /@devtool/]);
});

// ---- Rule: Read position is honest (DA-2, DA-4) ---------------------------------------------------------------------

scenario("Mark all read clears the conversation", { tag: ["@browser"] }, async ({ server, page, context, dataDir }) => {
  // Given conversation 41 has 7 unread main messages and 2 unread replies in an involved thread
  const w = await browserWorld({ server, page, context }, { live: ["devtool"], plaintext: true });
  const ids = await idsOf(w.owner);
  const conv = await createConversation(w.owner, { title: "Ship search filters", participants: ["devtool"] });
  const dev = w.sessions.devtool!;
  const root = await agentSays(w.srv, dev.lease, conv, "message 1");
  for (let i = 2; i <= 7; i++) await agentSays(w.srv, dev.lease, conv, `message ${i}`);
  seedReply(dataDir, conv, root, ids.devtool!, "reply 1");
  seedReply(dataDir, conv, root, ids.devtool!, "reply 2");
  seedDb(dataDir, (db) =>
    db.prepare("INSERT INTO thread_reads (identity_id, conversation_id, root_id, last_read_id, involved_at) VALUES (?, ?, ?, 0, ?)").run(ids.drew!, conv, root, Date.now()),
  );
  await page.goto(`${w.srv.origin}/chats`);
  const row = rowsOnList(page).filter({ hasText: "Ship search filters" });
  await expect(unreadDot(row)).toHaveText("Unread: 9"); // 7 main and, since WP5, the 2 replies of the thread it is in
  expect(await isBold(row.getByRole("heading"))).toBe(true);

  // When the owner marks the conversation read
  await row.click({ button: "right" });
  await page.getByRole("menu", { name: "Conversation actions" }).getByRole("menuitem", { name: "Mark all read" }).click();

  // Then conversation 41 shows no unread count and is not bold
  await expect(unreadDot(row)).toHaveCount(0);
  expect(await isBold(row.getByRole("heading"))).toBe(false);
  expect(await unreadOf(w.owner, conv)).toBe(0);
});

// ---- Rule: A loop pause is visible and the owner resumes it ---------------------------------------------------------------

scenario("A paused conversation shows a banner with Resume", { tag: ["@browser"] }, async ({ server, page, context }) => {
  // Given "devtool" and "docs" posted 20 messages in a row in conversation 41
  const w = await browserWorld({ server, page, context }, { live: ["devtool", "docs"] });
  const conv = await createConversation(w.owner, { title: "Ship search filters", participants: ["devtool", "docs"] });
  for (let i = 1; i <= 10; i++) {
    await agentSays(w.srv, w.sessions.devtool!.lease, conv, `devtool ${i}`);
    await agentSays(w.srv, w.sessions.docs!.lease, conv, `docs ${i}`);
  }
  expect((await viewOf(w.owner, conv)).paused).toBe(true);

  // When the owner opens conversation 41
  await openChat(page, w.srv, conv, "Ship search filters");

  // Then a banner says the agents are paused after 20 messages in a row
  const banner = page.getByRole("status").filter({ hasText: "paused after 20 messages in a row" });
  await expect(banner).toBeVisible();

  // And the banner has a Resume button
  await banner.getByRole("button", { name: "Resume" }).click();
  await expect(banner).toHaveCount(0);
  expect((await viewOf(w.owner, conv)).paused).toBeFalsy();
});

// ---- Rule: A conversation can be offered to any agent for pickup (SEC-6) -------------------------------------------------

scenario("The owner opens a conversation for pickup and one agent takes it", { tag: ["@browser", "@cli"] }, async ({ server, page, context }) => {
  // Given machine "box-2" has the pickup scope
  const w = await browserWorld({ server, page, context }, { live: ["devtool", "docs"], pickup: true });
  const conv = await createConversation(w.owner, { title: "Weekly usage", participants: [] });
  await openChat(page, w.srv, conv, "Weekly usage");

  // And the owner opened conversation 60 for pickup
  const panel = await showDetails(page);
  await panel.getByRole("button", { name: "Open for pickup" }).click();
  await expect(panel.locator("dd", { hasText: /^Open for pickup$/ })).toBeVisible();
  await panel.getByRole("button", { name: "Close details" }).click();

  // When "devtool" and "docs" run "convoz pickup 60" at the same time
  const runs = await Promise.all([w.sessions.devtool!, w.sessions.docs!].map((s) => convoz(w.box, s.sid, ["pickup", String(conv)])));

  // Then exactly one exits 0
  expect(runs.map((r) => r.code).sort()).toEqual([0, 4]);
  const [won, lost] = runs[0]!.code === 0 ? [runs[0]!, runs[1]!] : [runs[1]!, runs[0]!];
  const winner = runs[0]!.code === 0 ? "devtool" : "docs";
  expect(won.stdout).toContain(`picked up ${conv}`);

  // And the other exits 4 naming the agent that picked it up
  expect(lost.stderr).toContain(`@${winner} already picked up`);

  // And conversation 60 shows one system line naming the winner
  const lines = page.getByRole("log", { name: "Messages" }).getByText(/picked up this conversation/);
  await expect(lines).toHaveCount(1);
  await expect(lines).toHaveText(`@${winner} picked up this conversation`);
  expect((await viewOf(w.owner, conv)).picked_up_by?.handle).toBe(winner);
});

// ---- Rule: Messages arrive live ----------------------------------------------------------------------------------------------

scenario("The message details show who and where", { tag: ["@browser"] }, async ({ server, page, context }) => {
  // Given "devtool" posted from session "claude-7f3a" on "box-2"
  const w = await browserWorld({ server, page, context });
  const conv = await createConversation(w.owner, { title: "Ship search filters", participants: ["devtool"] });
  const started = await w.box.sessionStart("devtool", ["--label", "claude-7f3a"], { claude: "claude-TESTONLY-details" });
  expect(started.code, started.stderr).toBe(0);
  const posted = await convoz(w.box, sidOf(started), ["post", String(conv), "Build is green"]);
  expect(posted.code, posted.stderr).toBe(0);
  await openChat(page, w.srv, conv, "Ship search filters");

  // When the owner opens that message's details
  await message(page, "Build is green").getByRole("button", { name: "Message details" }).click();

  // Then they show "@devtool", session "claude-7f3a" and machine "box-2"
  const sheet = page.getByRole("dialog", { name: "Message details" });
  await expect(sheet.locator("dd", { hasText: "@devtool" })).toBeVisible();
  await expect(sheet.locator("dd", { hasText: "claude-7f3a" })).toBeVisible();
  await expect(sheet.locator("dd", { hasText: "box-2" })).toBeVisible();
});
