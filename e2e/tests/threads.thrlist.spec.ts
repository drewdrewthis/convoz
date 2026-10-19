import { agentSays } from "../lib/chat.ts";
import { recordStreams, streamOpen } from "../lib/chat-ui.ts";
import { expect, scenario } from "../lib/scenario.ts";
import { ROOT_TEXT, agentReplies, openRail, ownerHasRead, ownerReplies, threadLog, threadPane, threadWorld, type ThreadWorld } from "../lib/threads-wp5.ts";
import { seedDb } from "../lib/wp3.ts";
import type { Page } from "@playwright/test";

/*
 * THREADS ON THE LIST: specs/features/threads.feature, rule "The Conversations list shows every thread under its conversation"
 * (owner msgs 266-267). Under a conversation row the list shows an indented link "Open thread: <root text>" per thread with a reply,
 * newest reply first, with its own "Unread: N" count; the row of the conversation counts the main list only. Threads quiet since
 * yesterday sit under a per-conversation "Older · n" button.
 */
const threadRow = (page: Page, text: string | RegExp) => page.locator("#chats").getByRole("link", { name: typeof text === "string" ? new RegExp(`^Open thread: .*${text}`) : text });
const convRow = (page: Page) => page.locator("#chats a.chatrow").filter({ has: page.getByRole("heading", { name: "Ship search filters" }) });
const DAY = 86_400_000;

scenario("Each conversation lists its threads under it, and a thread opens from its row", { tag: ["@browser", "@I-14"] }, async ({ server, page, context }) => {
  const t = await threadWorld({ server, page, context }, { browser: true });

  // Given "devtool" and "docs" replied in thread 900 of conversation 41
  await agentReplies(t, t.dev, "Yes, it can");
  await agentReplies(t, t.docs, "Same here.");

  // When the owner opens the Conversations list
  await openRail(page, t.w.srv.origin);

  // Then conversation 41 lists thread 900 under it as an indented row with its root text
  const row = threadRow(page, ROOT_TEXT);
  await expect(row).toBeVisible();
  await expect(row).toContainText("↳");
  const box = (await row.boundingBox())!;
  expect(box.height).toBeGreaterThanOrEqual(44);
  expect(box.x).toBeGreaterThan((await convRow(page).boundingBox())!.x);

  // When the owner taps the row of thread 900
  await row.click();

  // Then the thread pane is open with the replies
  await expect(threadPane(page)).toBeVisible();
  await expect(threadLog(page).getByRole("article").filter({ hasText: "Same here." })).toBeVisible();
});

scenario("Thread replies count on the thread's row, not the conversation's", { tag: ["@browser", "@I-14"] }, async ({ server, page, context }) => {
  const t = await threadWorld({ server, page, context }, { browser: true });

  // Given the owner replied in thread 900 and has read conversation 41
  await ownerReplies(t, "Can step 1 ship on its own?");
  await ownerHasRead(t);

  // And the owner opened the Conversations list
  await recordStreams(context);
  await openRail(page, t.w.srv.origin);
  await streamOpen(page);
  const row = threadRow(page, ROOT_TEXT);
  await expect(row).toBeVisible();

  // When "devtool" posts 2 replies in thread 900
  await agentReplies(t, t.dev, "Yes, it can");
  await agentReplies(t, t.dev, "I will open the PR");

  // Then without a reload the row of thread 900 shows "Unread: 2" and conversation 41 shows no count
  await expect(row.getByText("Unread: 2")).toBeVisible();
  await expect(convRow(page).getByText(/^Unread: /)).toHaveCount(0);

  // When the owner opens thread 900
  await row.click();
  await expect(threadLog(page).getByRole("article").filter({ hasText: "I will open the PR" })).toBeVisible();
  await page.goto(`${t.w.srv.origin}/chats`);

  // Then the row of thread 900 shows no count
  await expect(threadRow(page, ROOT_TEXT)).toBeVisible();
  await expect(threadRow(page, ROOT_TEXT).getByText(/^Unread: /)).toHaveCount(0);
});

scenario("Threads with no reply since yesterday fold into Older under their conversation", { tag: ["@browser", "@I-21"] }, async ({ server, page, context, dataDir }) => {
  const t: ThreadWorld = await threadWorld({ server, page, context }, { browser: true });

  // Given thread 900 has a recent reply and thread 901 has no reply since yesterday
  await agentReplies(t, t.dev, "A fresh reply");
  const old = await agentSays(t.w.srv, t.dev, t.conv, "The older topic");
  await agentReplies({ ...t, root: old }, t.docs, "A stale reply");
  seedDb(dataDir, (db) => db.prepare("UPDATE messages SET created_at = created_at - ? WHERE thread_root_id = ?").run(2 * DAY, old));

  // When the owner opens the Conversations list
  await openRail(page, t.w.srv.origin);

  // Then conversation 41 lists thread 900 and the toggle "Older · 1" under it
  await expect(threadRow(page, ROOT_TEXT)).toBeVisible();
  const toggle = page.locator("#chats").getByRole("button", { name: "Older · 1" }).last();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(threadRow(page, "The older topic")).toHaveCount(0);

  // And expanding "Older · 1" shows thread 901
  await toggle.click();
  await expect(threadRow(page, "The older topic")).toBeVisible();
  await page.screenshot({ path: test_shot(page) });
});

function test_shot(page: Page): string {
  return (page.viewportSize()?.width ?? 0) < 600 ? "/tmp/thrlist-mobile.png" : "/tmp/thrlist-chromium.png";
}
