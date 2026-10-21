import type { Page } from "@playwright/test";
import { agentPost, createConversation } from "../lib/chat.ts";
import { message } from "../lib/chat-ui.ts";
import { QUESTION, agentAsks, answerAsk, askCard, openFold, openNow, ownerRepliesIn } from "../lib/asks.ts";
import { must } from "../lib/owner.ts";
import { expect, scenario } from "../lib/scenario.ts";
import { ROOT_TEXT, agentReplies, closeThread, openThread, ownerReplies, replyLine, threadOf, threadWorld, type ThreadWorld } from "../lib/threads-wp5.ts";
import { browserWorld } from "../lib/wp3.ts";

/*
 * REPLY COUNTS (owner, msg 1202 relayed in msg 1204): every "Reply in thread" shows a small count of the replies and of the new ones.
 * A thread root of a message list carries reply_count and the reader's unread_replies (absent for none), and so does the thread.updated
 * frame. An ask in Now carries the same two for the thread "Reply in thread" opens on it. The count is a span "N reply|replies" with
 * a bold " · M new" after it, beside the label of the button or menu item; the reply chip gets " · M new" after the last replier.
 * The bindings of the rule "Every Reply in thread shows how many replies the thread has and how many are new" of threads.feature, the
 * rule "A thread root carries its reply count and the reader's new replies" of the contracts, and one scenario each of now and asks.
 */

/** "Given the owner replied in thread 900, then "devtool" and "docs" answered". */
async function threeReplies(t: ThreadWorld): Promise<void> {
  await ownerReplies(t, "Can step 1 ship on its own?");
  await agentReplies(t, t.dev, "Yes.");
  await agentReplies(t, t.docs, "Another view.");
}

/** The "Reply in thread" item of the message actions of the root. */
async function replyItem(page: Page, text: string) {
  const root = message(page, text);
  await root.hover();
  await root.getByRole("button", { name: "Message actions" }).click();
  return page.getByRole("menuitem", { name: /^Reply in thread/ });
}

scenario("The reply chip and the message menu show the replies and the new ones", { tag: ["@browser"] }, async ({ server, page, context }) => {
  // Given the owner replied in thread 900, then "devtool" and "docs" answered
  const t = await threadWorld({ server, page, context }, { browser: true });
  await threeReplies(t);

  // When the owner opens conversation 41
  await page.goto(`${t.w.srv.origin}/chats/${t.conv}`);

  // Then the chip of message 900 reads "3 replies · @docs · 2 new"
  await expect(replyLine(message(page, ROOT_TEXT))).toHaveText("3 replies · @docs · 2 new");

  // When the owner opens the message actions of message 900
  const item = await replyItem(page, ROOT_TEXT);

  // Then "Reply in thread" shows "3 replies · 2 new"
  await expect(item).toHaveText("Reply in thread3 replies · 2 new");
  await expect(item.locator(".replynew")).toHaveText("· 2 new");
});

scenario("Opening the thread clears the new count", { tag: ["@browser"] }, async ({ server, page, context }) => {
  // Given the owner replied in thread 900, then "devtool" and "docs" answered
  const t = await threadWorld({ server, page, context }, { browser: true });
  await threeReplies(t);

  // And the owner has conversation 41 open
  await page.goto(`${t.w.srv.origin}/chats/${t.conv}`);
  const chip = replyLine(message(page, ROOT_TEXT));
  await expect(chip).toHaveText("3 replies · @docs · 2 new");

  // When the owner opens the thread and closes it again
  await chip.click();
  await expect(page.getByRole("log", { name: "Thread messages" }).getByRole("article").filter({ hasText: "Another view." })).toBeVisible();
  await closeThread(page);

  // Then the chip of message 900 reads "3 replies · @docs" and "Reply in thread" shows "3 replies" with no "new"
  await expect(chip).toHaveText("3 replies · @docs");
  const item = await replyItem(page, ROOT_TEXT);
  await expect(item).toHaveText("Reply in thread3 replies");
});

scenario("A message with no replies shows no count", { tag: ["@browser"] }, async ({ server, page, context }) => {
  // When the owner opens conversation 41 and the message actions of message 900
  const t = await threadWorld({ server, page, context }, { browser: true });
  await page.goto(`${t.w.srv.origin}/chats/${t.conv}`);
  const item = await replyItem(page, ROOT_TEXT);

  // Then "Reply in thread" shows no count
  await expect(item).toHaveText("Reply in thread");
  await expect(item.locator(".replycount")).toHaveCount(0);
});

scenario("A new reply brings the new count live", { tag: ["@browser"] }, async ({ server, page, context }) => {
  // Given the owner replied in thread 900, then "devtool" answered, and the owner read the thread
  const t = await threadWorld({ server, page, context }, { browser: true });
  await ownerReplies(t, "Can step 1 ship on its own?");
  await agentReplies(t, t.dev, "Yes.");
  await page.goto(`${t.w.srv.origin}/chats/${t.conv}`);
  const chip = replyLine(message(page, ROOT_TEXT));
  await expect(chip).toHaveText("2 replies · @devtool · 1 new");
  await openThread(page, ROOT_TEXT);
  await closeThread(page);
  await expect(chip).toHaveText("2 replies · @devtool");

  // When "docs" replies in thread 900
  await agentReplies(t, t.docs, "Another view.");

  // Then without a reload the chip reads "3 replies · @docs · 1 new"
  await expect(chip).toHaveText("3 replies · @docs · 1 new");
});

scenario("The message list carries the reply count and the new replies of the reader", { tag: ["@api"] }, async ({ server, page, context }) => {
  // Given the owner replied in thread 900, then "devtool" and "docs" answered
  const t = await threadWorld({ server, page, context });
  await threeReplies(t);

  // And "docs" replied in thread 901, a message of "devtool" the owner is not in
  const other = Number(must(await agentPost(t.w.srv, t.dev, t.conv, "Step 2 is the API"), "devtool posts message 901", 201).json().id);
  must(await agentPost(t.w.srv, t.docs, t.conv, "Looks fine", { thread_root_id: other }), "docs replies in thread 901", 201);

  // When the owner reads the messages of conversation 41
  const listed = async () =>
    (must(await t.w.owner.client.get(`/api/conversations/${t.conv}/messages?limit=100`), "list").json().messages as { id: number; reply_count?: number; unread_replies?: number }[]).reduce(
      (by, m) => by.set(m.id, m),
      new Map<number, { id: number; reply_count?: number; unread_replies?: number }>(),
    );
  const before = await listed();

  // Then message 900 has reply_count 3 and unread_replies 2
  expect([before.get(t.root)?.reply_count, before.get(t.root)?.unread_replies]).toEqual([3, 2]);

  // And message 901 has reply_count 1 and no unread_replies
  expect(before.get(other)?.reply_count).toBe(1);
  expect(before.get(other)).not.toHaveProperty("unread_replies");

  // When the owner reads thread 900
  const replies = (await threadOf(t.w.owner, t.root)).messages;
  must(await t.w.owner.client.post(`/api/conversations/${t.conv}/read`, { root_id: t.root, reply_id: replies[replies.length - 1]!.id }), "owner reads thread 900");

  // Then message 900 has reply_count 3 and no unread_replies
  const after = await listed();
  expect(after.get(t.root)?.reply_count).toBe(3);
  expect(after.get(t.root)).not.toHaveProperty("unread_replies");
});

scenario("The I have questions button of an ask shows the replies", { tag: ["@browser"] }, async ({ server, page, context }) => {
  // Given an open ask of "devtool" in conversation 41 and "docs" replied in its thread
  const w = await browserWorld({ server, page, context }, { agents: ["devtool", "docs"], live: ["devtool", "docs"] });
  const conv = await createConversation(w.owner, { title: "Ship search filters", participants: ["devtool", "docs"] });
  const id = await agentAsks(w.srv, w.sessions.devtool!.lease, conv);
  must(await agentPost(w.srv, w.sessions.docs!.lease, conv, "Any thoughts?", { thread_root_id: id }), "docs replies in the thread of the ask", 201);

  // When the owner opens conversation 41
  await page.goto(`${w.srv.origin}/chats/${conv}`);

  // Then "I have questions" on the ask shows "1 reply"
  await expect(askCard(page).getByRole("button", { name: /^I have questions/ })).toHaveText("I have questions1 reply");
});

scenario("I have questions on an ask and on a fold row shows the replies", { tag: ["@browser"] }, async ({ server, page, context }) => {
  // Given an open ask of "devtool" in Now that "docs" replied to twice in its thread, and an answered ask with one reply
  const w = await browserWorld({ server, page, context }, { agents: ["devtool", "docs"], live: ["devtool", "docs"] });
  const conv = await createConversation(w.owner, { title: "Ship search filters", participants: ["devtool", "docs"] });
  const lease = w.sessions.devtool!.lease;
  const docs = w.sessions.docs!.lease;
  const open = await agentAsks(w.srv, lease, conv);
  for (const text of ["Any thoughts?", "Still thinking"]) must(await agentPost(w.srv, docs, conv, text, { thread_root_id: open }), "docs replies", 201);
  const answered = await agentAsks(w.srv, lease, conv, { question: "Answered question?" });
  must(await answerAsk(w.owner, answered), "answer");
  must(await agentPost(w.srv, docs, conv, "Noted", { thread_root_id: answered }), "docs replies in the thread of the answered ask", 201);
  await agentAsks(w.srv, lease, conv, { question: "Plain question?" });

  // When the owner opens Now
  await openNow(page, w.srv);

  // Then "I have questions" on the open ask shows "2 replies"
  await expect(askCard(page, QUESTION).getByRole("button", { name: /^I have questions/ })).toHaveText("I have questions2 replies");

  // When the owner opens the folds in Now
  await openFold(page, "Answered today");

  // Then "Reply in thread" on the answered row shows "1 reply"
  await expect(page.locator(".foldrows li").filter({ hasText: "Answered question?" }).getByRole("link", { name: /^Reply in thread/ })).toHaveText("Reply in thread1 reply");

  // And an ask with no reply shows "I have questions" with no count
  await expect(askCard(page, "Plain question?").getByRole("button", { name: "I have questions", exact: true })).toHaveText("I have questions");
});

scenario("A You replied row shows the replies and the new ones, and the new clear when the thread is opened", { tag: ["@browser"] }, async ({ server, page, context }) => {
  // Given an open ask of "devtool" that the owner replied to, "devtool" replied in its thread, and the owner replied again
  const w = await browserWorld({ server, page, context }, { agents: ["devtool"], live: ["devtool"] });
  const conv = await createConversation(w.owner, { title: "Ship search filters", participants: ["devtool"] });
  const lease = w.sessions.devtool!.lease;
  const id = await agentAsks(w.srv, lease, conv);
  await ownerRepliesIn(w.owner, conv, id, "Which runner?");
  must(await agentPost(w.srv, lease, conv, "The small one", { thread_root_id: id }), "devtool replies in the thread of the ask", 201);
  // (the owner's reply must be the last word, or the ask leaves You replied)
  await ownerRepliesIn(w.owner, conv, id, "Why that one?");

  // When the owner opens Now
  await openNow(page, w.srv);

  // Then the row under "You replied · waiting on the agent" shows "3 replies · 1 new"
  const row = page.locator("#replied").getByRole("link", { name: new RegExp(QUESTION) });
  await expect(row).toContainText("3 replies · 1 new");

  // When the owner opens the thread from the row and goes back to Now
  const read = page.waitForResponse((r) => r.request().method() === "POST" && new URL(r.url()).pathname === `/api/conversations/${conv}/read` && Boolean(r.request().postData()?.includes("root_id")));
  await row.click();
  await read;
  await page.goBack();

  // Then the row shows "3 replies" with no "new"
  await expect(page.locator("#replied .replynew")).toHaveCount(0, { timeout: 10_000 });
  await expect(page.locator("#replied").getByRole("link", { name: new RegExp(QUESTION) })).toContainText("3 replies");
});
