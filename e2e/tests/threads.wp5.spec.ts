import type { Page } from "@playwright/test";
import { agentSays, convoz, createConversation, ownerSays, startWatch, watchLines } from "../lib/chat.ts";
import { backButton, message, messageLog, recordStreams, streamOpen, unreadDot } from "../lib/chat-ui.ts";
import { send } from "../lib/http.ts";
import { agentDeletes, agentPostWith, ownerPostWith } from "../lib/messages-wp4.ts";
import { must } from "../lib/owner.ts";
import { expect, scenario, test } from "../lib/scenario.ts";
import {
  NEWER_TEXT,
  ROOT_TEXT,
  agentReplies,
  closeThread,
  foldToggle,
  inlineThread,
  mainList,
  newerThread,
  openThread,
  ownerHasRead,
  ownerReplies,
  rail,
  threadPill,
  railState,
  replyBox,
  replyInThread,
  threadLog,
  threadOf,
  threadPane,
  threadWorld,
  unread,
  type ThreadWorld,
} from "../lib/threads-wp5.ts";
import { seedDb } from "../lib/wp3.ts";
import { installed } from "../lib/wp17.ts";

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
 * THE PAGE (locators are role, name and text only; issue 61, owner conv 112 msg 2893: the thread drawer is gone)
 *   Under a top-level message with replies, inside the log "Messages", a region "Thread: <the root's text, first 60 characters>" holds the
 *   replies as articles (smaller text, indented), oldest first. The thread of the newest root with replies shows every reply; any other
 *   is folded: its first 3 replies, one line each, and a button "Show all N replies" ("Show the whole reply" for one), with " · K new"
 *   when K replies are past the viewer's read point. Unfolded by hand it offers "Show fewer replies" (more than 3 replies). A thread
 *   shown in full is read (POST read root_id+reply_id); a folded one is not. The region has a button "Reply in thread" (text "Reply",
 *   at least 44 px). It opens the reply box in the region: a textbox "Reply in thread" (placeholder "Reply…"), "Send reply",
 *   "Attach a file to the reply", "Record a voice message", and "Cancel reply" (Escape too); no "Also send to conversation" box. One
 *   box is open at a time. "Reply in thread" is also an item of the "Message actions" menu of every message, and an arrow button
 *   "Reply in thread" beside "Message actions" on a hovered message (not on a touch screen). A link /chats/:id#reply=<root> opens the
 *   conversation at the root with its thread unfolded and the box open and focused. A reply that is also in the main list (broadcast)
 *   reads "replied to a thread" above it there. A thread root carries reply_count, unread_replies and last_reply {id, author, preview
 *   (at most 120 characters), created_at, unread?} in the messages list and in the thread.updated frame.
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

/**
 * Open the Conversations list with a full load, so what it shows is what the server says now. The service worker must control the
 * page first: a page it does not control is a cold page, which carries the list inline and never asks the network for it.
 */
async function freshRail(page: Page, t: ThreadWorld): Promise<void> {
  await installed(page);
  await Promise.all([page.waitForResponse((r) => r.request().method() === "GET" && new URL(r.url()).pathname === "/api/conversations"), page.goto(`${t.w.srv.origin}/chats`)]);
  await rail(page).waitFor();
}

// ---- Rule: A thread hangs off one top-level message ----------------------------------------------------------

scenario("The owner replies in a thread", { tag: ["@browser"] }, async ({ server, page, context }) => {
  // Background
  const t = await threadWorld({ server, page, context }, { browser: true });
  await page.goto(`${t.w.srv.origin}/chats/${t.conv}`);
  await expect(message(page, ROOT_TEXT)).toBeVisible();

  // When the owner opens the reply box of message 900 and replies "Can step 1 ship on its own?"
  await openThread(page, ROOT_TEXT);
  await replyInThread(page, "Can step 1 ship on its own?");

  // Then the reply shows in the thread under message 900
  const thread = inlineThread(page, ROOT_TEXT);
  await expect(thread.getByRole("article").filter({ hasText: "Can step 1 ship on its own?" })).toBeVisible();
  await expect(replyBox(page)).toHaveValue("");

  // And the main list has no message of its own for the reply: the root and, in its thread, the reply
  await expect(messageLog(page).getByRole("article")).toHaveCount(2);
  await expect(thread.getByRole("article")).toHaveCount(1);
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

  // And the thread under message 900 shows the 5 replies
  await expect(inlineThread(page, ROOT_TEXT).getByRole("article")).toHaveCount(5);

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

scenario("Opening the conversation does not clear the replies of a folded thread", { tag: ["@browser", "@I-14"] }, async ({ server, page, context }) => {
  // Background
  const t = await threadWorld({ server, page, context }, { browser: true });

  // Given the owner replied in thread 900 and "devtool" then posted 2 replies there
  await ownerHasRead(t);
  await ownerReplies(t, "Can step 1 ship on its own?");
  await agentReplies(t, t.dev, "Yes, it can");
  await agentReplies(t, t.dev, "I will open the PR");
  // And a newer message 901 has a thread, so thread 900 is folded
  await newerThread(t);
  await agentSays(t.w.srv, t.dev, t.conv, "A note in the main list"); // main unread too: opening the conversation reads this one only
  expect(await unread(t)).toBe(3);

  // When the owner opens conversation 41 but does not unfold thread 900
  await page.goto(`${t.w.srv.origin}/chats/${t.conv}`);
  await expect(message(page, "A note in the main list")).toBeVisible();
  await expect(foldToggle(inlineThread(page, ROOT_TEXT))).toHaveText("Show all 3 replies · 2 new");

  // Owner msgs 266-267 (2026-10-19): "I guess this means that there are 5 unviewed items hidden in threads somewhere?" / "so I should
  // actually see all the threads on the lists". The conversation badge is the main chat only; thread replies count on the thread's row.
  // Then the row of thread 900 still shows 2 unread and conversation 41 shows no count
  await expect.poll(() => unread(t)).toBe(2);
  await backButton(page).click();
  await freshRail(page, t);
  expect(await railState(page)).toEqual({ bold: false, unread: "" });
  await expect(threadPill(page, ROOT_TEXT)).toHaveText("Unread: 2");

  // And unfolding thread 900 clears them
  await rail(page).locator("a.chatrow").click();
  await foldToggle(inlineThread(page, ROOT_TEXT)).click();
  await expect(inlineThread(page, ROOT_TEXT).getByRole("article").filter({ hasText: "I will open the PR" })).toBeVisible();
  await expect.poll(() => unread(t)).toBe(0);
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

  // When the owner reads it in the thread under message 900 (the latest thread: it shows in full)
  await page.goto(`${t.w.srv.origin}/chats/${t.conv}`);
  await expect(message(page, "Yes, and the main list should know").filter({ hasText: "replied to a thread" })).toBeVisible(); // the thread shows the text too
  await expect(inlineThread(page, ROOT_TEXT).getByRole("article").filter({ hasText: "Yes, and the main list should know" })).toBeVisible();

  // Then conversation 41 shows no unread for it in the main list
  await expect.poll(() => unread(t)).toBe(0);
  expect(mainCursor(dataDir, t.conv)).toBeLessThan(broadcast); // read in the thread, not by the main cursor
  await page.unroute("**/api/conversations/*/read");
  await backButton(page).click();
  await freshRail(page, t);
  expect(await railState(page)).toEqual({ bold: false, unread: "" });
});

scenario("Messages that never count as unread", { tag: ["@browser", "@I-14"] }, async ({ server, page, context }) => {
  // Background
  const t = await threadWorld({ server, page, context }, { browser: true });
  await ownerHasRead(t);
  await recordStreams(context);
  await freshRail(page, t);
  // The rail learns of a new message by the live stream: a post made before the stream opens is never pushed to the page.
  await streamOpen(page);

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

    // And the conversation shows no replying note: the one note in the log is the thread's
    await expect(page.getByRole("log", { name: "Messages", exact: true }).getByRole("status").filter({ hasText: "replying" })).toHaveCount(1);
  } finally {
    watch.stop();
  }
});

scenario("Following a reply link to the conversation that is already open opens the thread", { tag: ["@browser"] }, async ({ server, page, context }) => {
  // Given conversation 41 is open
  const t = await threadWorld({ server, page, context }, { browser: true });
  await page.goto(`${t.w.srv.origin}/chats/${t.conv}`);
  await expect(message(page, ROOT_TEXT)).toBeVisible();
  await expect(replyBox(page)).toHaveCount(0);

  // When the owner follows the link "/chats/41#reply=900" without reloading
  await page.evaluate((hash) => (location.hash = hash), `#reply=${t.root}`);

  // Then the thread under message 900 is unfolded with its reply box open and focused
  await expect(inlineThread(page, ROOT_TEXT).getByRole("textbox", { name: "Reply in thread" })).toBeFocused();
  await expect(message(page, ROOT_TEXT)).toBeInViewport();
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

  // When "devtool" posts 150 messages and the owner posts through the API after every 15
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
scenario("One tap on Reply under a thread opens its reply box", { tag: ["@browser", "@phone"] }, async ({ server, page, context }) => {
  // Given conversation 41 is open on a phone with a thread on its first message
  const t = await threadWorld({ server, page, context }, { browser: true });
  await agentReplies(t, t.dev, "Can step 1 ship on its own?");
  await page.goto(`${t.w.srv.origin}/chats/${t.conv}`);
  const reply = inlineThread(page, ROOT_TEXT).getByRole("button", { name: "Reply in thread", exact: true });
  await expect(reply).toBeVisible();

  // When the owner taps "Reply" under the thread once
  await reply.tap();

  // Then the reply box is open
  await expect(replyBox(page)).toBeVisible({ timeout: 2000 });
  // And "Reply" is at least 44 px tall
  await closeThread(page);
  expect((await reply.boundingBox())!.height).toBeGreaterThanOrEqual(44);

  // And the replies show no "Message actions" button while message 900 keeps its own (a long press still opens a reply's menu)
  await expect(inlineThread(page, ROOT_TEXT).getByRole("button", { name: "Message actions" })).toHaveCount(0);
  await expect(message(page, ROOT_TEXT).getByRole("button", { name: "Message actions" })).toHaveCSS("opacity", "1");
});

// ---- Rule: A thread shows in the conversation under its root -------------------------------------------------
// Owner, conv 112 msg 2893 (issue 61): "if there's a reply/thread, it should still be visible in the main conversation. If it's the latest
// message, the thread is fully expanded (maybe smaller text) ... If it's not the latest message, the reply can be collapsed: show at least
// three lines when collapsed, but you should be able to expand the whole thread in the conversation view."

scenario("The latest thread shows every reply and an older one folds to its first three", { tag: ["@browser"] }, async ({ server, page, context }) => {
  // Given thread 900 has 5 replies and a newer message 901 has a thread with 4 replies
  const t = await threadWorld({ server, page, context }, { browser: true });
  for (let i = 1; i <= 5; i++) await agentReplies(t, t.docs, `docs on step 1, reply ${i} `.repeat(i === 2 ? 12 : 1).trim());
  await newerThread(t, 4);

  // When the owner opens conversation 41
  await page.goto(`${t.w.srv.origin}/chats/${t.conv}`);

  // Then the thread under message 901 shows all 4 replies in smaller text than the main list, indented under its root
  const newer = inlineThread(page, NEWER_TEXT);
  await expect(newer.getByRole("article")).toHaveCount(4);
  await expect(foldToggle(newer)).toHaveCount(0);
  const size = async (l: import("@playwright/test").Locator) => Number.parseFloat(await l.evaluate((e) => getComputedStyle(e).fontSize));
  const rootText = message(page, NEWER_TEXT).getByText(NEWER_TEXT);
  const replyText = newer.getByRole("article").first().getByText("docs on step 2, 1");
  expect(await size(replyText)).toBeLessThan(await size(rootText));
  expect((await replyText.boundingBox())!.x).toBeGreaterThan((await rootText.boundingBox())!.x);

  // And the thread under message 900 shows its first 3 replies, one line each, and "Show all 5 replies"
  const older = inlineThread(page, ROOT_TEXT);
  await expect(older.getByRole("article")).toHaveCount(3);
  const long = older.getByRole("article").nth(1).getByText(/docs on step 1, reply 2/);
  const line = await long.evaluate((e) => Number.parseFloat(getComputedStyle(e).lineHeight));
  expect((await long.boundingBox())!.height).toBeLessThanOrEqual(line * 1.6);
  await expect(foldToggle(older)).toHaveText("Show all 5 replies");
  await expect(foldToggle(older)).toHaveAttribute("aria-expanded", "false");

  // When the owner taps "Show all 5 replies"
  await foldToggle(older).click();

  // Then the thread under message 900 shows all 5 replies in place
  await expect(older.getByRole("article")).toHaveCount(5);
  expect((await long.boundingBox())!.height).toBeGreaterThan(line * 1.6);
  await expect(page).toHaveURL(`${t.w.srv.origin}/chats/${t.conv}`);

  // And "Show fewer replies" folds it again
  await expect(foldToggle(older)).toHaveText("Show fewer replies");
  await foldToggle(older).click();
  await expect(older.getByRole("article")).toHaveCount(3);
});

scenario("A new reply shows live in its thread", { tag: ["@browser"] }, async ({ server, page, context }) => {
  // Given conversation 41 is open and thread 900 has 1 reply
  const t = await threadWorld({ server, page, context }, { browser: true });
  await agentReplies(t, t.dev, "Fixing it to open on one tap.");
  await page.goto(`${t.w.srv.origin}/chats/${t.conv}`);
  const thread = inlineThread(page, ROOT_TEXT);
  await expect(thread.getByRole("article")).toHaveCount(1);

  // When "docs" replies "Same here." in thread 900
  await agentReplies(t, t.docs, "Same here.");

  // Then without a reload the thread under message 900 shows "Same here."
  await expect(thread.getByRole("article").filter({ hasText: "Same here." })).toBeVisible();
  await expect(thread.getByRole("article")).toHaveCount(2);
});

scenario("The reply box has no Also send to conversation box", { tag: ["@browser"] }, async ({ server, page, context }) => {
  // Given the owner opened the reply box of message 900
  const t = await threadWorld({ server, page, context }, { browser: true });
  await page.goto(`${t.w.srv.origin}/chats/${t.conv}`);
  await openThread(page, ROOT_TEXT);

  // Then the box has no "Also send to conversation" box
  await expect(replyBox(page)).toBeVisible();
  await expect(threadPane(page).getByRole("checkbox")).toHaveCount(0);
  await expect(threadPane(page)).not.toContainText("Also send to conversation");

  // And a reply stays in the thread
  await replyInThread(page, "Step 1 can ship alone");
  await expect(threadLog(page).getByRole("article").filter({ hasText: "Step 1 can ship alone" })).toBeVisible();
  expect((await mainList(t.w.owner, t.conv)).map((m) => m.body)).toEqual([ROOT_TEXT]);
});

scenario("Cancel reply closes the box and the thread stays", { tag: ["@browser"] }, async ({ server, page, context }) => {
  // Given the owner replied in the thread under message 900
  const t = await threadWorld({ server, page, context }, { browser: true });
  await page.goto(`${t.w.srv.origin}/chats/${t.conv}`);
  await openThread(page, ROOT_TEXT);
  await replyInThread(page, "Step 1 can ship alone");
  await expect(threadLog(page).getByRole("article").filter({ hasText: "Step 1 can ship alone" })).toBeVisible();

  // When the owner taps "Cancel reply"
  await closeThread(page);

  // Then the reply box is gone and the thread still shows the reply
  await expect(replyBox(page)).toHaveCount(0);
  await expect(inlineThread(page, ROOT_TEXT).getByRole("article").filter({ hasText: "Step 1 can ship alone" })).toBeVisible();
  // Escape closes it too
  await openThread(page, ROOT_TEXT);
  await replyBox(page).press("Escape");
  await expect(replyBox(page)).toHaveCount(0);
});

scenario("A folded thread shows its new replies until it is unfolded", { tag: ["@browser", "@I-14"] }, async ({ server, page, context }) => {
  // Given the owner replied in thread 900 and "devtool" answered, and a newer message 901 has a thread
  const t = await threadWorld({ server, page, context }, { browser: true });
  await ownerReplies(t, "Can step 1 ship on its own?");
  await agentReplies(t, t.dev, "Yes.");
  const newer = await newerThread(t);
  // the latest thread (901) is read as it shows in full: once that has gone out, a read of 900 would have too
  const readNewer = page.waitForRequest((r) => r.url().endsWith(`/api/conversations/${t.conv}/read`) && r.postDataJSON()?.root_id === newer);
  await page.goto(`${t.w.srv.origin}/chats/${t.conv}`);
  await readNewer;
  const toggle = foldToggle(inlineThread(page, ROOT_TEXT));

  // Then the thread under message 900 offers "Show all 2 replies · 1 new"
  await expect(toggle).toHaveText("Show all 2 replies · 1 new");
  expect((await mainList(t.w.owner, t.conv)).find((m) => m.id === t.root)?.last_reply?.unread).toBe(true);
  expect(await unread(t), "a folded thread is not read").toBe(1);

  // When the owner unfolds it
  await toggle.click();
  await expect(inlineThread(page, ROOT_TEXT).getByRole("article")).toHaveCount(2);

  // Then the new count is gone, and a newer reply brings it back on the folded thread of a reload
  await expect.poll(() => unread(t)).toBe(0);
  // the reply comes while the conversation is closed: on screen, the thread unfolded by hand would read it at once
  await page.goto(`${t.w.srv.origin}/chats`);
  await agentReplies(t, t.docs, "Another view.");
  await page.goto(`${t.w.srv.origin}/chats/${t.conv}`);
  await expect(foldToggle(inlineThread(page, ROOT_TEXT))).toHaveText("Show all 3 replies · 1 new");
});

// Owner: "The reply icon/placement can be better."
scenario("On a desktop a reply arrow shows on a hovered message and opens its reply box", { tag: ["@browser"] }, async ({ server, page, context }, info) => {
  test.skip(info.project.name !== "chromium", "a touch screen has no hover: the phone scenarios cover it");
  // Given conversation 41 is open on a desktop and message 900 has no replies
  const t = await threadWorld({ server, page, context }, { browser: true });
  await page.goto(`${t.w.srv.origin}/chats/${t.conv}`);
  const root = message(page, ROOT_TEXT);
  const arrow = root.getByRole("button", { name: "Reply in thread", exact: true });
  await expect(arrow).toHaveCSS("opacity", "0");

  // When the owner hovers message 900 and taps its "Reply in thread" arrow
  await root.hover();
  await expect(arrow).toHaveCSS("opacity", "1");
  await arrow.click();

  // Then a reply box opens under message 900 and has the focus
  await expect(inlineThread(page, ROOT_TEXT).getByRole("textbox", { name: "Reply in thread" })).toBeFocused();
});

scenario("Request mini app replies to the agent in the thread of its message", { tag: ["@browser"] }, async ({ server, page, context }) => {
  const t = await threadWorld({ server, page, context }, { browser: true });
  // Given the owner posted "Owner note here" in conversation 41
  await ownerSays(t.w.owner, t.conv, "Owner note here");
  await page.goto(`${t.w.srv.origin}/chats/${t.conv}`);

  // When the owner opens the message actions of message 900 and taps "Request mini app"
  const root = message(page, ROOT_TEXT).first();
  await root.hover();
  await root.getByRole("button", { name: "Message actions" }).click();
  await page.getByRole("menuitem", { name: "Request mini app", exact: true }).click();

  // Then the thread of message 900 gets the owner's reply to "@devtool" with "convoz app init" and "Good looks like"
  const asked = async () => (await threadOf(t.w.owner, t.root)).messages.map((m) => m.body).find((b) => b.startsWith("@devtool, ")) ?? "";
  await expect.poll(asked).toContain("convoz app init");
  expect(await asked()).toContain("Good looks like");
  await expect(inlineThread(page, ROOT_TEXT).getByRole("article").filter({ hasText: "Good looks like" })).toBeVisible();

  // And the message actions of "Owner note here" have no "Request mini app"
  const mine = message(page, "Owner note here");
  await mine.hover();
  await mine.getByRole("button", { name: "Message actions" }).click();
  await expect(page.getByRole("menuitem", { name: "Copy link", exact: true })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Request mini app", exact: true })).toHaveCount(0);
});
