import { agentPost, createConversation } from "../lib/chat.ts";
import { box } from "../lib/mobile.ts";
import { must } from "../lib/owner.ts";
import { patchPrefs } from "../lib/rail-wp9.ts";
import { expect, scenario } from "../lib/scenario.ts";
import { newerThread, ownerReplies, threadWorld } from "../lib/threads-wp5.ts";
import { idsOf, seedAsk, seedDb } from "../lib/wp3.ts";

/*
 * THE CONVERSATIONS LIST ON A PHONE (owner, conv 132 msg 3322: "mobile ui here is shit"). At 390x844 each conversation is one row: its
 * fold chevron sits on the row, not alone on a line under it; the Now badge reads "15" on one line; and the last row scrolls clear of the
 * "New conversation" button, a round "+" on a phone.
 */
scenario("On a phone the Conversations list keeps each row on one line and the last row clear of New conversation", { tag: ["@browser", "@phone"] }, async ({ server, dataDir, page, context }, info) => {
  const t = await threadWorld({ server, page, context }, { browser: true });

  // Given starred "Ship search filters" has a read thread (Older) and a newer thread with 2 unread replies
  await ownerReplies(t, "Can step 1 ship on its own?");
  await newerThread(t, 2);
  must(await patchPrefs(t.w.owner, t.conv, { starred: true }), "star conversation 41");
  // And its last message is longer than the row, as most are
  must(await agentPost(t.w.srv, t.docs, t.conv, "Don't ask me questions if you don't actually need to. The plan stands as written."), "docs posts", 201);
  const ids = await idsOf(t.w.owner);
  const dev = ids.devtool!;
  // And 8 more conversations with unread messages from "devtool"
  const titles = ["Scenario hooks for HTTP agents", "PLG nurturing: lifecycle emails", "Calls with @voice", "Governor agent (@advisor)", "Docs search", "Weekly usage", "Deploy alerts runbook", "Billing page"];
  for (const [i, title] of titles.entries()) {
    const conv = await createConversation(t.w.owner, { participants: ["devtool"], title });
    // a few through the API (the rate limit allows that much), the rest straight into the database
    must(await agentPost(t.w.srv, t.dev, conv, `Update 1 on ${title}`), "devtool posts", 201);
    seedDb(dataDir, (db) => {
      for (let n = 2; n <= 1 + i * 2; n++) db.prepare("INSERT INTO messages (conversation_id, author_id, kind, body, created_at) VALUES (?, ?, 'text', ?, ?)").run(conv, dev, `Update ${n} on ${title}, with a preview long enough to be cut at the edge`, Date.now());
    });
  }
  // And 15 asks wait on the owner
  for (let n = 1; n <= 15; n++) seedAsk(dataDir, t.conv, ids.devtool!, ids.drew!, `Question ${n}?`, "open");

  // When the owner opens Conversations on a phone
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto(`${t.w.srv.origin}/chats`);
  const row = page.locator("#chats li").filter({ has: page.getByRole("heading", { name: "Ship search filters" }) });
  const fold = row.getByRole("button", { name: "Fold threads of Ship search filters" });
  await expect(fold).toBeVisible();
  await info.attach("list, top (390x844)", { body: await page.screenshot(), contentType: "image/png" });

  // Then the fold chevron sits on the conversation's row, not on a line of its own
  const r = await box(row.locator("a.chatrow"));
  const f = await box(fold);
  expect(f.y + f.height / 2).toBeGreaterThan(r.y);
  expect(f.y + f.height / 2).toBeLessThan(r.y + r.height);

  // And the Now badge reads "15" on one line
  const badge = page.locator("#now-badge");
  await expect(badge).toHaveText("15");
  expect((await box(badge)).height).toBeLessThanOrEqual(20);

  // And the unread counts of the conversation rows share one right edge
  const rights = await page.locator("#chats a.chatrow .count").evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().right)));
  expect(rights.length).toBeGreaterThan(3);
  expect(new Set(rights).size).toBe(1);

  // When the owner scrolls to the end of the list
  await page.locator("main").evaluate((m) => m.scrollTo(0, m.scrollHeight));
  await info.attach("list, end (390x844)", { body: await page.screenshot(), contentType: "image/png" });

  // Then the last row ends above the New conversation button, a round "+" that keeps its name for a screen reader
  const last = await box(page.locator("#chats a.chatrow").last());
  const fab = await box(page.getByRole("link", { name: "New conversation" }).last());
  expect(last.y + last.height).toBeLessThanOrEqual(fab.y);
  expect(fab.width).toBeLessThanOrEqual(56);
});
