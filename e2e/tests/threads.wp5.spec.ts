import type { Page } from "@playwright/test";
import { agentSays, convoz, createConversation, ownerSays, startWatch, watchLines } from "../lib/chat.ts";
import { backButton, message, messageLog, unreadDot } from "../lib/chat-ui.ts";
import { send } from "../lib/http.ts";
import { agentDeletes, agentPostWith, ownerPostWith } from "../lib/messages-wp4.ts";
import { must } from "../lib/owner.ts";
import { expect, scenario } from "../lib/scenario.ts";
import {
  ROOT_TEXT,
  agentReplies,
  closeThread,
  mainList,
  openThread,
  ownerHasRead,
  ownerReplies,
  rail,
  threadPill,
  railState,
  replyBox,
  replyInThread,
  replyLine,
  replyPeek,
  sendReply,
  threadLog,
  threadOf,
  threadPane,
  threadWorld,
  unread,
  type ThreadWorld,
} from "../lib/threads-wp5.ts";
import { seedDb } from "../lib/wp3.ts";

/*
 * THREADS (WP5): specs/features/threads.feature and specs/contracts/threads.feature. The page and routes these bindings assert:
 *
 * ROUTES
 *   GET /api/messages/:id/replies?after=&limit=  the thread of one top-level message, found from the message (no conversation id):
 *        {conversation_id, root, messages, as_of_seq}, oldest first; `root` is the root message, whenever the reader joined. 404 for a message the caller cannot see, 400 for a system line; a message inside a thread names its thread (the root comes back).
 *   POST /api/conversations/:id/read  {main_id?, root_id+reply_id?, all?}: root_id with reply_id moves the reader's position in one
 *        thread (never past its newest reply; only a thread the reader is in has a position, I-14); all also clears every thread.
 *   convoz reply [--broadcast] <message> <text|->  posts {thread_root_id[, broadcast]} to the conversation of the message.
 *
 * UNREAD (design §8.2, I-14): a reply counts only in a thread the reader is in - it wrote the root, replied, or was @mentioned there.
 *   Its own, system and deleted messages never count. A broadcast reply counts once, in the main list, and is read there once it is
 *   read in its thread. Opening a conversation moves the main cursor only. The rail row is bold with an "Unread: N" pill (99+ above 99).
 *
 * THE PAGE (locators are role, name and text only)
 *   Under a thread root in the main list a bold reply chip, a button "Open thread, N replies · @handle" (N reply, 1 reply; "you" for the
 *   viewer, ", unread" after it when the last reply is past the viewer's read point), and under it a faded peek, a button "Last reply by
 *   handle: preview". One tap on either opens the thread. A thread root carries last_reply {id, author, preview (at most 120 characters),
 *   created_at, unread?} in the messages list and in the thread.updated frame. "Reply in thread" is an item
 *   of the "Message actions" menu of a message without replies. The thread opens as a dialog "Thread in <title>" on a phone and as a
 *   complementary "Thread in <title>" beside the chat on a wide screen. Inside: a log "Thread messages" (the root, then the replies), a
 *   textbox "Reply in thread" (placeholder "Reply…"), a button "Send reply" (no "Also send to conversation" box), and "Close thread"
 *   (wide) or "Back" (phone). A reply that is also in the main list reads "replied to a thread" above it there.
 */

/** The data file's read cursor of the owner for a conversation, where the scenarios look at what the main list does not do. */
function mainCursor(dataDir: string, conv: number): number {
  return seedDb(dataDir, (db) => Number((db.prepare("SELECT last_read_main_id AS n FROM read_cursors WHERE conversation_id = ?").get(conv) as { n: number }).n));
}

/** A system line "@docs joined" in conversation 41, written the way the action that causes it does (test hook, testhooks build). Returns its id. */
async function docsJoined(t: ThreadWorld): Promise<number> {
  const res = await send(t.w.srv.target, "POST", "/__test/system-line", { json: { conversation: t.conv, t: "member.added", identity: "docs", by: "drew", via: "mention" } });
  return must(res, "write a system line").json().id as number;
}

/** Open the Conversations list with a full load, so what it shows is what the server says now. */
async function freshRail(page: Page, t: ThreadWorld): Promise<void> {
  await Promise.all([page.waitForResponse((r) => r.request().method() === "GET" && new URL(r.url()).pathname === "/api/conversations"), page.goto(`${t.w.srv.origin}/chats`)]);
  await rail(page).waitFor();
}

// ---- Rule: A thread hangs off one top-level message ----------------------------------------------------------

scenario("The owner replies in a thread", { tag: ["@browser"] }, async ({ server, page, context }) => {
  // Background
  const t = await threadWorld({ server, page, context }, { browser: true });
  await page.goto(`${t.w.srv.origin}/chats/${t.conv}`);
  await expect(message(page, ROOT_TEXT)).toBeVisible();

  // When the owner opens the thread of message 900 and replies "Can step 1 ship on its own?"
  await openThread(page, ROOT_TEXT);
  await replyInThread(page, "Can step 1 ship on its own?");

  // Then the thread pane shows the reply
  await expect(threadLog(page).getByRole("article").filter({ hasText: "Can step 1 ship on its own?" })).toBeVisible();
  await expect(replyBox(page)).toHaveValue("");

  // And message 900 shows "1 reply" in the main list
  await closeThread(page);
  await expect(replyLine(message(page, ROOT_TEXT))).toContainText("1 reply");

  // And the main list does not show the reply itself
  await expect(messageLog(page).getByRole("article")).toHaveCount(1);
  await expect(replyPeek(message(page, ROOT_TEXT))).toHaveText("you: Can step 1 ship on its own?"); // owner design B: the root peeks at it, it is no message of the list
  expect((await mainList(t.w.owner, t.conv)).map((m) => m.body)).toEqual([ROOT_TEXT]);
  expect((await threadOf(t.w.owner, t.root)).messages.map((m) => m.body)).toEqual(["Can step 1 ship on its own?"]);
});

// ---- Rule: Thread replies count as unread only where the owner is involved (DA-3) ---------------------------

scenario("Replies in a thread the owner is not in never make the conversation bold", { tag: ["@browser", "@I-14"] }, async ({ server, page, context }) => {
  // Background
  const t = await threadWorld({ server, page, context }, { browser: true });

  // Given the owner has read conversation 41
  await ownerHasRead(t);
  await page.goto(`${t.w.srv.origin}/chats/${t.conv}`);
  await expect(message(page, ROOT_TEXT)).toBeVisible();

  // When "docs" posts 5 replies in thread 900
  for (let i = 1; i <= 5; i++) await agentReplies(t, t.docs, `docs reply ${i}`);

  // And message 900 shows "5 replies" with the last replier
  await expect(replyLine(message(page, ROOT_TEXT))).toHaveText("5 replies · @docs");

  // Then conversation 41 is not bold in the rail
  await backButton(page).click();
  await freshRail(page, t);
  expect(await railState(page)).toEqual({ bold: false, unread: "" });
  expect(await unread(t)).toBe(0);
});

scenario("Replies in a thread the owner replied in count as unread", { tag: ["@browser", "@I-14"] }, async ({ server, page, context }) => {
  // Background
  const t = await threadWorld({ server, page, context }, { browser: true });

  // Given the owner replied in thread 900 and has read conversation 41
  await ownerReplies(t, "Can step 1 ship on its own?");
  await ownerHasRead(t);
  expect(await unread(t)).toBe(0);

  // When "devtool" posts 2 replies in thread 900
  await agentReplies(t, t.dev, "Yes, it can");
  await agentReplies(t, t.dev, "I will open the PR");

  // Owner msgs 266-267 (2026-10-19): "I guess this means that there are 5 unviewed items hidden in threads somewhere?" / "so I should
  // actually see all the threads on the lists". The conversation badge is the main chat only; thread replies count on the thread's row.
  // Then the row of thread 900 shows 2 unread and conversation 41 is not bold and shows no count
  await freshRail(page, t);
  expect(await railState(page)).toEqual({ bold: false, unread: "" });
  await expect(threadPill(page, ROOT_TEXT)).toHaveText("Unread: 2");
  expect(await unread(t)).toBe(2);
});

scenario("A mention in a thread makes the owner involved", { tag: ["@browser", "@I-14"] }, async ({ server, page, context }) => {
  // Background
  const t = await threadWorld({ server, page, context }, { browser: true });

  // Given the owner has read conversation 41
  await ownerHasRead(t);
  await agentReplies(t, t.docs, "A reply before the mention"); // the owner is not in the thread yet
  expect(await unread(t)).toBe(0);

  // When "devtool" replies "@drew can you confirm?" in thread 900
  await agentReplies(t, t.dev, "@drew can you confirm?");

  // Owner msgs 266-267 (2026-10-19): "I guess this means that there are 5 unviewed items hidden in threads somewhere?" / "so I should
  // actually see all the threads on the lists". The conversation badge is the main chat only; thread replies count on the thread's row.
  // Then the row of thread 900 shows 1 unread and conversation 41 is not bold and shows no count
  await freshRail(page, t);
  expect(await railState(page)).toEqual({ bold: false, unread: "" });
  await expect(threadPill(page, ROOT_TEXT)).toHaveText("Unread: 1");
  expect(await unread(t)).toBe(1);
});

scenario("Opening the conversation does not clear thread replies", { tag: ["@browser", "@I-14"] }, async ({ server, page, context }) => {
  // Background
  const t = await threadWorld({ server, page, context }, { browser: true });

  // Given the owner replied in thread 900 and "devtool" then posted 2 replies there
  await ownerHasRead(t);
  await ownerReplies(t, "Can step 1 ship on its own?");
  await agentReplies(t, t.dev, "Yes, it can");
  await agentReplies(t, t.dev, "I will open the PR");
  await agentSays(t.w.srv, t.dev, t.conv, "A note in the main list"); // main unread too: opening the conversation reads this one only
  expect(await unread(t)).toBe(3);

  // When the owner opens conversation 41 but not the thread
  await page.goto(`${t.w.srv.origin}/chats/${t.conv}`);
  await expect(message(page, "A note in the main list")).toBeVisible();
  await expect(replyLine(message(page, ROOT_TEXT))).toContainText("3 replies");

  // Owner msgs 266-267 (2026-10-19): "I guess this means that there are 5 unviewed items hidden in threads somewhere?" / "so I should
  // actually see all the threads on the lists". The conversation badge is the main chat only; thread replies count on the thread's row.
  // Then the row of thread 900 still shows 2 unread and conversation 41 shows no count
  await expect.poll(() => unread(t)).toBe(2);
  await backButton(page).click();
  await freshRail(page, t);
  expect(await railState(page)).toEqual({ bold: false, unread: "" });
  await expect(threadPill(page, ROOT_TEXT)).toHaveText("Unread: 2");

  // And opening thread 900 clears them
  await rail(page).locator("a.chatrow").click();
  await openThread(page, ROOT_TEXT);
  await expect(threadLog(page).getByRole("article").filter({ hasText: "I will open the PR" })).toBeVisible();
  await expect.poll(() => unread(t)).toBe(0);
  await closeThread(page);
  await backButton(page).click();
  await freshRail(page, t);
  expect(await railState(page)).toEqual({ bold: false, unread: "" });
});

scenario("A broadcast reply read in its thread is read in the main list", { tag: ["@browser", "@I-14"] }, async ({ server, page, context, dataDir }) => {
  // Background
  const t = await threadWorld({ server, page, context }, { browser: true });

  // Given the owner replied in thread 900
  await ownerReplies(t, "Can step 1 ship on its own?");
  await ownerHasRead(t);

  // And "devtool" posted a broadcast reply in thread 900
  const broadcast = await agentReplies(t, t.dev, "Yes, and the main list should know", true);
  expect(await unread(t)).toBe(1); // it counts once, in the main list
  // The page may not move the main cursor, so that only the thread can clear it.
  await page.route("**/api/conversations/*/read", async (route) => {
    if (route.request().postDataJSON()?.root_id) return route.fallback();
    await route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
  });

  // When the owner reads it in the thread pane
  await page.goto(`${t.w.srv.origin}/chats/${t.conv}`);
  await expect(message(page, "Yes, and the main list should know").filter({ hasText: "replied to a thread" })).toBeVisible(); // the root's peek shows the text too
  await openThread(page, ROOT_TEXT);
  await expect(threadLog(page).getByRole("article").filter({ hasText: "Yes, and the main list should know" })).toBeVisible();

  // Then conversation 41 shows no unread for it in the main list
  await expect.poll(() => unread(t)).toBe(0);
  expect(mainCursor(dataDir, t.conv)).toBeLessThan(broadcast); // read in the thread, not by the main cursor
  await closeThread(page);
  await page.unroute("**/api/conversations/*/read");
  await backButton(page).click();
  await freshRail(page, t);
  expect(await railState(page)).toEqual({ bold: false, unread: "" });
});

scenario("Messages that never count as unread", { tag: ["@browser", "@I-14"] }, async ({ server, page, context }) => {
  // Background
  const t = await threadWorld({ server, page, context }, { browser: true });
  await ownerHasRead(t);
  await freshRail(page, t);

  // Control: a message from another person does count, and the rail shows it without a reload
  await agentSays(t.w.srv, t.dev, t.conv, "this one counts");
  await expect(unreadDot(rail(page))).toHaveText("Unread: 1");
  await ownerHasRead(t);

  // Examples: each row starts from "the owner has read conversation 41"
  const rows: { message: string; arrives: () => Promise<void> }[] = [
    { message: "the owner's own message from another device", arrives: async () => void (await ownerSays(t.w.owner, t.conv, "from my laptop")) },
    {
      message: 'a system line "@docs joined"',
      arrives: async () => void (await docsJoined(t)),
    },
    {
      message: 'a message from "devtool" that it deletes at once',
      arrives: async () => {
        const id = await agentSays(t.w.srv, t.dev, t.conv, "posted by mistake");
        must(await agentDeletes(t.w.srv, t.dev, id), "devtool deletes it");
      },
    },
  ];
  for (const row of rows) {
    // Given the owner has read conversation 41
    await ownerHasRead(t);
    // When <message> arrives
    await row.arrives();
    // Then conversation 41 is not bold
    expect(await unread(t), row.message).toBe(0);
    await freshRail(page, t);
    expect(await railState(page), row.message).toEqual({ bold: false, unread: "" });
  }
});

// ---- Contracts ------------------------------------------------------------------------------------------------

scenario("The owner sees an agent replying in a thread", { tag: ["@browser"] }, async ({ server, page, context }) => {
  // Given "devtool" runs "convoz watch --json" and the owner has the thread of message 900 open
  const t = await threadWorld({ server, page, context }, { browser: true });
  const watch = startWatch(t.w.box, t.devSid);
  try {
    await page.goto(`${t.w.srv.origin}/chats/${t.conv}`);
    await expect(message(page, ROOT_TEXT)).toBeVisible();
    await openThread(page, ROOT_TEXT);

    // When the owner replies "Can step 1 ship on its own?" in the thread
    await replyInThread(page, "Can step 1 ship on its own?");
    await watchLines(watch, 1, 3_000);

    // Then the thread shows "@devtool is replying…" within 3 seconds
    await expect(threadPane(page).getByRole("status").filter({ hasText: "@devtool is replying…" })).toBeVisible({ timeout: 3_000 });

    // And the conversation shows no replying note
    await expect(page.getByRole("log", { name: "Messages", exact: true }).getByRole("status").filter({ hasText: "replying" })).toHaveCount(0);
  } finally {
    watch.stop();
  }
});

scenario("Following a reply link to the conversation that is already open opens the thread", { tag: ["@browser"] }, async ({ server, page, context }) => {
  // Given conversation 41 is open
  const t = await threadWorld({ server, page, context }, { browser: true });
  await page.goto(`${t.w.srv.origin}/chats/${t.conv}`);
  await expect(message(page, ROOT_TEXT)).toBeVisible();
  await expect(threadPane(page)).toHaveCount(0);

  // When the owner follows the link "/chats/41#reply=900" without reloading
  await page.evaluate((hash) => (location.hash = hash), `#reply=${t.root}`);

  // Then the thread pane is open on message 900
  await expect(threadPane(page)).toBeVisible();
  await expect(threadLog(page).getByRole("article").filter({ hasText: ROOT_TEXT })).toBeVisible();
});

scenario("A watch line from a thread names the thread root", { tag: ["@cli"] }, async ({ server }) => {
  // Given "devtool" runs "convoz watch --json"
  const t = await threadWorld({ server });
  const watch = startWatch(t.w.box, t.devSid);
  try {
    // When the owner replies inside thread 900
    const inside = await ownerReplies(t, "Can step 1 ship on its own?");
    const [line] = await watchLines(watch, 1, 3_000);

    // Then the watch line carries "thread_root_id" 900
    expect({ message_id: line?.message_id, thread_root_id: line?.thread_root_id }).toEqual({ message_id: inside, thread_root_id: t.root });

    // And the watch line for a message in the main list carries no "thread_root_id"
    const elsewhere = await createConversation(t.w.owner, { title: "Deploy alerts runbook", participants: ["devtool"] });
    const main = await ownerSays(t.w.owner, elsewhere, "@devtool and this one is not in a thread");
    const lines = await watchLines(watch, 2, 3_000);
    expect(lines.find((l) => l.message_id === main)).not.toHaveProperty("thread_root_id");
  } finally {
    watch.stop();
  }
});

scenario("Reply to a message inside a thread goes to its root", { tag: ["@cli"] }, async ({ server }) => {
  // Given "docs" replied "Looks fine to me" in thread 900
  const t = await threadWorld({ server });
  const inside = await agentReplies(t, t.docs, "Looks fine to me");

  // When "devtool" runs "convoz reply" on that reply with "Thanks, shipping it"
  const res = await convoz(t.w.box, t.devSid, ["reply", "--fyi", String(inside), "Thanks, shipping it"]);

  // Then the command succeeds and thread 900 shows the new reply
  expect(res.code, res.stderr).toBe(0);
  expect(res.stdout).toMatch(/^\d+\n$/);
  expect((await threadOf(t.w.owner, t.root)).messages.map((m) => m.body)).toEqual(["Looks fine to me", "Thanks, shipping it"]);

  // And the main list does not show it
  expect((await mainList(t.w.owner, t.conv)).map((m) => m.body)).toEqual([ROOT_TEXT]);
});

scenario("An agent answers inside the thread", { tag: ["@cli"] }, async ({ server }) => {
  // Background
  const t = await threadWorld({ server });

  // When "devtool" runs "convoz reply 900 'Yes, it works without the API'"
  const res = await convoz(t.w.box, t.devSid, ["reply", "--fyi", String(t.root), "Yes, it works without the API"]);
  expect(res.code, res.stderr).toBe(0);
  expect(res.stdout).toMatch(/^\d+\n$/);

  // Then the owner sees the reply in thread 900 and not in the main list
  const thread = await threadOf(t.w.owner, t.root);
  expect(thread.messages.map((m) => m.body)).toEqual(["Yes, it works without the API"]);
  expect(thread.conversation_id).toBe(t.conv);
  expect((await mainList(t.w.owner, t.conv)).map((m) => m.body)).toEqual([ROOT_TEXT]);
});

scenario("Thread structure rules", { tag: ["@api", "@invariant", "@I-8"] }, async ({ server }) => {
  // Background
  const t = await threadWorld({ server });
  const inside = await ownerReplies(t, "a reply inside thread 900");
  const other = await createConversation(t.w.owner, { title: "Deploy alerts runbook", participants: ["devtool"] });
  const elsewhere = await ownerSays(t.w.owner, other, "a message in another conversation");
  const line = await docsJoined(t);

  const examples: { root: string; id: number }[] = [
    { root: "a reply that is already inside thread 900", id: inside },
    { root: "a message in conversation 52", id: elsewhere },
    { root: "a system line in conversation 41", id: line },
  ];
  for (const { root, id } of examples) {
    // When a client posts a reply to <root>
    const res = await ownerPostWith(t.w.owner, t.conv, { body: `a reply to ${root}`, thread_root_id: id });
    // Then the server answers 400
    expect(res.status, root).toBe(400);
    expect(res.json().error.field, root).toBe("thread_root_id");
    const agent = await agentPostWith(t.w.srv, t.dev, t.conv, { body: `an agent reply to ${root}`, thread_root_id: id });
    expect(agent.status, `${root} (an agent)`).toBe(400);
  }
  expect((await threadOf(t.w.owner, t.root)).messages.map((m) => m.body)).toEqual(["a reply inside thread 900"]);
});

scenario("The unread count caps at 99+", { tag: ["@browser", "@I-14"] }, async ({ server, page, context, testApi }) => {
  // Background
  const t = await threadWorld({ server, page, context }, { browser: true });

  // Given the owner has read conversation 41
  await ownerHasRead(t);

  // When "devtool" posts 150 messages and the owner posts through the API after every 15 to keep the loop breaker off
  for (let i = 1; i <= 150; i++) {
    await agentSays(t.w.srv, t.dev, t.conv, `message ${i}`);
    if (i % 15 === 0) {
      await ownerSays(t.w.owner, t.conv, `owner after ${i}`);
      await testApi(t.w.srv).advanceClock(21_000); // the post budget of an agent is 20 in 20 seconds
    }
  }

  // Then the rail shows "99+" for conversation 41
  await freshRail(page, t);
  await expect(unreadDot(rail(page))).toHaveText("Unread: 99+");
  expect(await unread(t)).toBe(100);
});

// Owner ruling 2026-10-18 (iPhone, Chrome): "Also opening it requires a double click."
scenario("One tap on the reply chip opens the thread pane", { tag: ["@browser", "@phone"] }, async ({ server, page, context }) => {
  // Given conversation 41 is open on a phone with a thread on its first message
  const t = await threadWorld({ server, page, context }, { browser: true });
  await agentReplies(t, t.dev, "Can step 1 ship on its own?");
  await page.goto(`${t.w.srv.origin}/chats/${t.conv}`);
  const chip = replyLine(message(page, ROOT_TEXT));
  await expect(chip).toBeVisible();

  // When the owner taps the reply chip once
  await chip.tap();

  // Then the thread pane is open
  await expect(threadPane(page)).toBeVisible({ timeout: 2000 });
  // And the reply chip is at least 44 px tall
  await closeThread(page);
  expect((await chip.boundingBox())!.height).toBeGreaterThanOrEqual(44);
});

// ---- Rule: A thread root shows its last reply in the main list -----------------------------------------------
// Owner decision 2026-10-18, design B in the mini app: "Replies stay in the thread. The message gets a bold reply chip and a faded peek of
// the last reply. Tap the chip to open the thread." Earlier, verbatim: "'also reply in the conversation' I think this is dumb. I want a
// better ui. Should be clear in the main, and easy to jump into a thread."

scenario("The reply chip shows the count and the last replier", { tag: ["@browser"] }, async ({ server, page, context }) => {
  // Given "devtool" and "docs" replied in thread 900, "docs" last
  const t = await threadWorld({ server, page, context }, { browser: true });
  await agentReplies(t, t.dev, "Fixing it to open on one tap.");
  await agentReplies(t, t.docs, "Looks right to me.");

  // When the owner opens conversation 41
  await page.goto(`${t.w.srv.origin}/chats/${t.conv}`);

  // Then message 900 has a chip "2 replies · @docs" at least 44 px tall
  const chip = replyLine(message(page, ROOT_TEXT));
  await expect(chip).toHaveText("2 replies · @docs");
  expect((await chip.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  // And the server sent the last reply with the root
  const root = (await mainList(t.w.owner, t.conv)).find((m) => m.id === t.root);
  expect(root?.last_reply).toMatchObject({ author: { handle: "docs", kind: "agent" }, preview: "Looks right to me." });

  // And a reply of the owner reads "you"
  await ownerReplies(t, "Ship it.");
  await expect(chip).toHaveText("3 replies · you");
});

scenario("The peek shows the last reply", { tag: ["@browser"] }, async ({ server, page, context }) => {
  // Given "devtool" replied "Fixing it to open on one tap." in thread 900 and "docs" replied with a long reply
  const t = await threadWorld({ server, page, context }, { browser: true });
  await agentReplies(t, t.dev, "Fixing it to open on one tap.");
  const long = "docs says this reply is long ".repeat(12);
  await agentReplies(t, t.docs, `**${long}**`);

  // When the owner opens conversation 41
  await page.goto(`${t.w.srv.origin}/chats/${t.conv}`);

  // Then under the chip one faded line shows "docs: <the reply as plain text>" cut with an ellipsis
  const peek = replyPeek(message(page, ROOT_TEXT));
  await expect(peek).toContainText("docs: docs says this reply is long");
  await expect(peek).not.toContainText("**");
  await expect(peek).toHaveCSS("text-overflow", "ellipsis");
  const root = (await mainList(t.w.owner, t.conv)).find((m) => m.id === t.root);
  expect(root!.last_reply!.preview.length).toBeLessThanOrEqual(120);
  expect(root!.last_reply!.preview.length).toBeGreaterThan(100);
});

scenario("A new reply updates the chip live", { tag: ["@browser"] }, async ({ server, page, context }) => {
  // Given conversation 41 is open and message 900 shows "1 reply · @devtool"
  const t = await threadWorld({ server, page, context }, { browser: true });
  await agentReplies(t, t.dev, "Fixing it to open on one tap.");
  await page.goto(`${t.w.srv.origin}/chats/${t.conv}`);
  const root = message(page, ROOT_TEXT);
  await expect(replyLine(root)).toHaveText("1 reply · @devtool");

  // When "docs" replies in thread 900
  await agentReplies(t, t.docs, "Same here.");

  // Then, without a reload, the chip reads "2 replies · @docs" and the peek "docs: Same here."
  await expect(replyLine(root)).toHaveText("2 replies · @docs");
  await expect(replyPeek(root)).toHaveText("docs: Same here.");
});

scenario("One tap on the peek opens the thread", { tag: ["@browser", "@phone"] }, async ({ server, page, context }) => {
  // Given conversation 41 is open on a phone and message 900 has a reply
  const t = await threadWorld({ server, page, context }, { browser: true });
  await agentReplies(t, t.dev, "Fixing it to open on one tap.");
  await page.goto(`${t.w.srv.origin}/chats/${t.conv}`);
  const peek = replyPeek(message(page, ROOT_TEXT));
  await expect(peek).toBeVisible();
  expect((await peek.boundingBox())!.height).toBeGreaterThanOrEqual(44);

  // When the owner taps the peek once
  await peek.tap();

  // Then the thread pane is open with the reply
  await expect(threadPane(page)).toBeVisible({ timeout: 2000 });
  await expect(threadLog(page).getByRole("article").filter({ hasText: "Fixing it to open on one tap." })).toBeVisible();
});

scenario("The thread pane has no Also send to conversation box", { tag: ["@browser"] }, async ({ server, page, context }) => {
  // Given the owner opened the thread of message 900
  const t = await threadWorld({ server, page, context }, { browser: true });
  await page.goto(`${t.w.srv.origin}/chats/${t.conv}`);
  await openThread(page, ROOT_TEXT);

  // Then the pane has a reply box and no "Also send to conversation" box
  await expect(replyBox(page)).toBeVisible();
  await expect(threadPane(page).getByRole("checkbox")).toHaveCount(0);
  await expect(threadPane(page)).not.toContainText("Also send to conversation");

  // And a reply stays in the thread
  await replyInThread(page, "Step 1 can ship alone");
  await expect(threadLog(page).getByRole("article").filter({ hasText: "Step 1 can ship alone" })).toBeVisible();
  expect((await mainList(t.w.owner, t.conv)).map((m) => m.body)).toEqual([ROOT_TEXT]);
});

scenario("The chip has a dot while the last reply is unread", { tag: ["@browser", "@I-14"] }, async ({ server, page, context }) => {
  // Given the owner replied in thread 900 and "devtool" answered
  const t = await threadWorld({ server, page, context }, { browser: true });
  await ownerReplies(t, "Can step 1 ship on its own?");
  await agentReplies(t, t.dev, "Yes.");
  await page.goto(`${t.w.srv.origin}/chats/${t.conv}`);
  const chip = replyLine(message(page, ROOT_TEXT));

  // Then the chip shows a dot
  await expect(chip).toHaveAccessibleName(/, unread$/);
  expect((await mainList(t.w.owner, t.conv)).find((m) => m.id === t.root)?.last_reply?.unread).toBe(true);

  // When the owner reads the thread
  await chip.click();
  await expect(threadLog(page).getByRole("article").filter({ hasText: "Yes." })).toBeVisible();
  await closeThread(page);

  // Then the dot is gone, and a newer reply brings it back
  await expect(chip).not.toHaveAccessibleName(/unread/);
  await agentReplies(t, t.docs, "Another view.");
  await expect(chip).toHaveText("3 replies · @docs");
  await expect(chip).toHaveAccessibleName(/, unread$/);
});
