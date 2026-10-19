import { agentSays, ownerSays } from "../lib/chat.ts";
import { message, messageLog, recordStreams, streamOpen } from "../lib/chat-ui.ts";
import { expect, scenario } from "../lib/scenario.ts";
import { ROOT_TEXT, agentReplies, closeThread, openRail, openThread, ownerHasRead, ownerReplies, threadLog, threadPane, threadWorld, type ThreadWorld } from "../lib/threads-wp5.ts";
import { seedDb } from "../lib/wp3.ts";
import type { Locator, Page } from "@playwright/test";

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

scenario("A long thread preview stays inside the row and keeps its unread count in view", { tag: ["@browser", "@I-14"] }, async ({ server, page, context }) => {
  const t = await threadWorld({ server, page, context }, { browser: true });

  // Given a thread with a very long root text has 3 unread replies
  const long = "Filters are done and behind a flag. Three things are left: the empty state, the saved views and the keyboard shortcuts for every chip in the bar";
  const root = await agentSays(t.w.srv, t.dev, t.conv, long);
  await ownerReplies({ ...t, root }, "Looking at it");
  for (const body of ["First", "Second", "Third"]) await agentReplies({ ...t, root }, t.docs, body);

  // When the owner opens the Conversations list at 320, 390 and 1280 px wide
  for (const width of [320, 390, 1280]) {
    await page.setViewportSize({ width, height: 800 });
    await openRail(page, t.w.srv.origin);

    // Then every thread row ends inside its list and its unread count is in view
    const lists = width >= 1280 ? ["#chats", "nav.rail"] : ["#chats"];
    for (const list of lists) {
      const m = await page.locator(list).evaluate((el, w) => {
        const edge = el.getBoundingClientRect().right;
        const rows = [...el.querySelectorAll<HTMLElement>("li.thrrow, .thrrow")].filter((r) => r.textContent?.includes("Filters are done"));
        const text = rows.map((r) => r.querySelector<HTMLElement>(".thrtext")!);
        return {
          rows: rows.length,
          overshoot: Math.max(...rows.map((r) => r.getBoundingClientRect().right - edge)),
          badgeOut: Math.max(...rows.map((r) => r.querySelector(".thrcount")!.getBoundingClientRect().right - w)),
          clipped: text.every((e) => e.scrollWidth > e.clientWidth),
          overflowX: document.documentElement.scrollWidth - w,
        };
      }, width);
      expect(m.rows, `${list} rows at ${width}`).toBeGreaterThan(0);
      expect(m.overshoot, `${list} row right edge at ${width}`).toBeLessThanOrEqual(0.5);
      expect(m.badgeOut, `${list} badge at ${width}`).toBeLessThanOrEqual(0);

      // And the long preview ends with an ellipsis and the page does not scroll sideways
      expect(m.clipped, `${list} preview clipped at ${width}`).toBe(true);
      expect(m.overflowX, `page sideways scroll at ${width}`).toBeLessThanOrEqual(0);
    }
    if (width === 390) await page.screenshot({ path: "/tmp/thrwrap-mobile.png" });
  }
});

scenario("A long link in a thread stays inside its bubble", { tag: ["@browser"] }, async ({ server, page, context }) => {
  const t = await threadWorld({ server, page, context }, { browser: true });

  // Given the owner and "devtool" posted a message that is one very long link, in the thread and in the conversation
  const link = (who: string) => `https://langwatch.slack.com/archives/C0123456789/p1760000000123456?thread_ts=1760000000.123456&cid=C0123456789&utm_source=${who}_share_link_with_a_very_long_tail_0123456789`;
  await ownerReplies(t, link("owner_thread"));
  await agentReplies(t, t.dev, link("agent_thread"));
  await ownerSays(t.w.owner, t.conv, link("owner_main"));
  await agentSays(t.w.srv, t.dev, t.conv, link("agent_main"));

  // Owner (Drew, msg 685): "ui fail on long links in threads"
  const fits = (log: Locator, tag: string) =>
    log.evaluate((el, key) => {
      const edge = el.getBoundingClientRect();
      const rows = [...el.querySelectorAll<HTMLElement>("article")].filter((a) => a.textContent?.includes(key));
      return {
        rows: rows.length,
        // the text itself (not only its box) must be inside the pane: a bubble can be inside while its text runs out
        out: Math.max(...rows.map((a) => Math.max(edge.left - a.querySelector(".text")!.getBoundingClientRect().left, a.querySelector(".text")!.getBoundingClientRect().right - edge.right))),
        textOut: Math.max(...rows.map((a) => a.querySelector<HTMLElement>(".text")!.scrollWidth - a.querySelector<HTMLElement>(".text")!.clientWidth)),
        sideways: document.documentElement.scrollWidth - window.innerWidth,
      };
    }, tag);

  // When the owner opens the conversation and the thread at 1280 and 390 px wide
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 800 });
    await page.goto(`${t.w.srv.origin}/chats/${t.conv}`);
    await expect(message(page, ROOT_TEXT)).toBeVisible();

    // Then every long link ends inside the bubble, the bubble ends inside the pane, and the page does not scroll sideways
    for (const tag of ["owner_main", "agent_main"]) {
      const m = await fits(messageLog(page), tag);
      expect(m.rows, `${tag} rows at ${width}`).toBe(1);
      expect(m.out, `${tag} bubble outside the chat at ${width}`).toBeLessThanOrEqual(0.5);
      expect(m.textOut, `${tag} text wider than its bubble at ${width}`).toBeLessThanOrEqual(0);
      expect(m.sideways, `page sideways scroll at ${width}`).toBeLessThanOrEqual(0);
    }
    await openThread(page, ROOT_TEXT);
    for (const tag of ["owner_thread", "agent_thread"]) {
      const m = await fits(threadLog(page), tag);
      expect(m.rows, `${tag} rows at ${width}`).toBe(1);
      expect(m.out, `${tag} bubble outside the pane at ${width}`).toBeLessThanOrEqual(0.5);
      expect(m.textOut, `${tag} text wider than its bubble at ${width}`).toBeLessThanOrEqual(0);
      expect(m.sideways, `page sideways scroll at ${width}`).toBeLessThanOrEqual(0);
    }
    if (width === 1280) await page.screenshot({ path: "/tmp/linkwrap-thread.png" });
    await closeThread(page);
  }
});

scenario("The message actions button does not cover the time", { tag: ["@browser"] }, async ({ server, page, context }) => {
  const t = await threadWorld({ server, page, context }, { browser: true });

  // Given the owner replied in thread 900, and the owner and "devtool" each posted in the conversation
  await ownerReplies(t, "On it");
  await ownerSays(t.w.owner, t.conv, "Mine in the list");
  await agentSays(t.w.srv, t.dev, t.conv, "Theirs in the list");

  // Owner (Drew, msg 685 screenshot): the message's ⋯ button covered the bubble's time ("5:" cut)
  const overlap = (log: Locator, text: string) =>
    log.getByRole("article").filter({ hasText: text }).first().evaluate((a) => {
      const stamp = a.querySelector(".stamp")!.getBoundingClientRect();
      const btn = a.querySelector(".msg-actions-btn")!.getBoundingClientRect();
      return Math.min(stamp.right, btn.right) - Math.max(stamp.left, btn.left) > 0.5 && Math.min(stamp.bottom, btn.bottom) - Math.max(stamp.top, btn.top) > 0.5;
    });

  // When the owner looks at the messages at 1280 and 390 px wide
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 800 });
    await page.goto(`${t.w.srv.origin}/chats/${t.conv}`);
    await expect(message(page, "Mine in the list")).toBeVisible();

    // Then no message's actions button sits over its time, in the conversation and in the thread pane
    for (const text of ["Mine in the list", "Theirs in the list"]) expect(await overlap(messageLog(page), text), `${text} at ${width}`).toBe(false);
    await openThread(page, ROOT_TEXT);
    expect(await overlap(threadLog(page), "On it"), `thread reply at ${width}`).toBe(false);
    await closeThread(page);
  }
});

function test_shot(page: Page): string {
  return (page.viewportSize()?.width ?? 0) < 600 ? "/tmp/thrlist-mobile.png" : "/tmp/thrlist-chromium.png";
}
