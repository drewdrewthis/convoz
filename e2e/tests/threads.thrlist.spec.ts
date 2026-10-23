import { agentPost, agentSays, createConversation, ownerSays, peekFor } from "../lib/chat.ts";
import { must } from "../lib/owner.ts";
import { message, messageLog, recordStreams, streamOpen } from "../lib/chat-ui.ts";
import { expect, scenario, test } from "../lib/scenario.ts";
import { ROOT_TEXT, agentReplies, closeThread, openRail, openThread, ownerHasRead, ownerReplies, replyBox, sendReply, threadLog, threadPane, threadWorld, type ThreadWorld } from "../lib/threads-wp5.ts";
import { handlesOf, seedDb, viewOf } from "../lib/wp3.ts";
import type { Locator, Page } from "@playwright/test";

/*
 * THREADS ON THE LIST: specs/features/threads.feature, rule "The Conversations list shows every thread under its conversation"
 * (owner msgs 266-267). Under a conversation row the list shows an indented link "Open thread: <root text>" per thread with a reply,
 * newest reply first, with its own "Unread: N" count; the row of the conversation counts the main list only. Threads with no unread message
 * sit under a per-conversation "Older · n" button (owner msg 1855).
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

  // Then the conversation opens with the thread under message 900 unfolded and its reply box open
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
  // thread 900 has nothing unread yet, so it sits under "Older · 1"
  await expect(page.locator("#chats").getByRole("button", { name: "Older · 1" }).last()).toBeVisible();

  // When "devtool" posts 2 replies in thread 900
  await agentReplies(t, t.dev, "Yes, it can");
  await agentReplies(t, t.dev, "I will open the PR");

  // Then without a reload thread 900 leaves Older, its row shows "Unread: 2", and conversation 41 shows no count
  await expect(row.getByText("Unread: 2")).toBeVisible();
  await expect(convRow(page).getByText(/^Unread: /)).toHaveCount(0);

  // When the owner folds the threads of conversation 41, its row counts the 2 hidden replies (owner, msg 2055)
  await page.locator("#chats").getByRole("button", { name: "Fold threads of Ship search filters" }).click();
  await expect(convRow(page).getByText("Unread: 2")).toBeVisible();
  // And showing the threads again moves the count back to thread 900's row
  await page.locator("#chats").getByRole("button", { name: "Show threads of Ship search filters" }).click();
  await expect(convRow(page).getByText(/^Unread: /)).toHaveCount(0);

  // When the owner opens thread 900
  await row.click();
  await expect(threadLog(page).getByRole("article").filter({ hasText: "I will open the PR" })).toBeVisible();
  await page.goto(`${t.w.srv.origin}/chats`);

  // Then thread 900, read now, sits under "Older · 1" and its row shows no count
  await page.locator("#chats").getByRole("button", { name: "Older · 1" }).last().click();
  await expect(threadRow(page, ROOT_TEXT)).toBeVisible();
  await expect(threadRow(page, ROOT_TEXT).getByText(/^Unread: /)).toHaveCount(0);
});

scenario("Threads with no unread message fold into Older under their conversation", { tag: ["@browser", "@I-21"] }, async ({ server, page, context, dataDir }) => {
  const t: ThreadWorld = await threadWorld({ server, page, context }, { browser: true });

  // Given thread 900 has an unread reply, thread 901 has only the owner's own reply, and thread 902 has an unread reply from 2 days ago
  await agentReplies(t, t.dev, "A fresh reply");
  const read = await agentSays(t.w.srv, t.dev, t.conv, "The read topic");
  await ownerReplies({ ...t, root: read }, "My own reply");
  const stale = await agentSays(t.w.srv, t.dev, t.conv, "The stale unread topic");
  await agentReplies({ ...t, root: stale }, t.docs, "A stale reply");
  seedDb(dataDir, (db) => db.prepare("UPDATE messages SET created_at = created_at - ? WHERE thread_root_id = ?").run(2 * DAY, stale));

  // When the owner opens the Conversations list
  await openRail(page, t.w.srv.origin);

  // Then threads 900 and 902 show, and thread 901 sits under the toggle "Older · 1"
  await expect(threadRow(page, ROOT_TEXT)).toBeVisible();
  await expect(threadRow(page, "The stale unread topic")).toBeVisible();
  const toggle = page.locator("#chats").getByRole("button", { name: "Older · 1" }).last();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(threadRow(page, "The read topic")).toHaveCount(0);

  // And expanding "Older · 1" shows thread 901
  await toggle.click();
  await expect(threadRow(page, "The read topic")).toBeVisible();
  await page.screenshot({ path: test_shot(page) });
});

scenario("A conversation folds its threads by its chevron, and stays folded after a reload", { tag: ["@browser"] }, async ({ server, page, context }) => {
  const t = await threadWorld({ server, page, context }, { browser: true });

  // Given "devtool" replied in thread 900 of conversation 41 (owner, msg 1855: a starred conversation's threads flooded the rail)
  await agentReplies(t, t.dev, "Yes, it can");

  // When the owner opens the Conversations list and taps the chevron of conversation 41
  await openRail(page, t.w.srv.origin);
  await expect(threadRow(page, ROOT_TEXT)).toBeVisible();
  const fold = page.locator("#chats").getByRole("button", { name: "Fold threads of Ship search filters" });
  await expect(fold).toHaveAttribute("aria-expanded", "true");
  await fold.click();

  // Then thread 900 is not listed, and the chevron says it shows the threads
  await expect(threadRow(page, ROOT_TEXT)).toHaveCount(0);
  const show = page.locator("#chats").getByRole("button", { name: "Show threads of Ship search filters" });
  await expect(show).toHaveAttribute("aria-expanded", "false");

  // And after a reload the threads stay folded
  await page.reload();
  await expect(show).toBeVisible();
  await expect(threadRow(page, ROOT_TEXT)).toHaveCount(0);

  // And tapping the chevron again lists thread 900
  await show.click();
  await expect(threadRow(page, ROOT_TEXT)).toBeVisible();
});

// Issue 31: one button folds the threads of every conversation, and shows them again.
scenario("One button folds the threads of every conversation, and stays folded after a reload", { tag: ["@browser"] }, async ({ server, page, context }, info) => {
  test.skip(info.project.name !== "chromium", "the fold-all button is on the desktop sidebar only");
  // Given conversations 41 and a second one each have a thread with a reply
  const t = await threadWorld({ server, page, context }, { browser: true });
  await agentReplies(t, t.dev, "Yes, it can");
  const other = await createConversation(t.w.owner, { participants: ["devtool"], title: "Deploy alerts runbook" });
  const root = await agentSays(t.w.srv, t.dev, other, "Alerts topic");
  must(await agentPost(t.w.srv, t.dev, other, "Alerts reply", { thread_root_id: root }), "reply in the second thread", 201);

  // When the owner opens the list and presses "Fold all threads"
  await openRail(page, t.w.srv.origin);
  const nav = page.getByRole("navigation", { name: "Conversations" });
  const rows = nav.getByRole("link", { name: /^Open thread:/ });
  await expect(rows).toHaveCount(2);
  await nav.getByRole("button", { name: "Fold all threads" }).click();

  // Then no thread row is listed, also after a reload, and the button says "Show all threads"
  await expect(rows).toHaveCount(0);
  await page.reload();
  const show = nav.getByRole("button", { name: "Show all threads" });
  await expect(show).toBeVisible();
  await expect(rows).toHaveCount(0);

  // And pressing it lists the threads again
  await show.click();
  await expect(rows).toHaveCount(2);
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

  // When the owner opens the conversation and the reply box of the thread at 1280 and 390 px wide
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 800 });
    await page.goto(`${t.w.srv.origin}/chats/${t.conv}`);
    await expect(message(page, ROOT_TEXT)).toBeVisible();

    // Then every long link ends inside the bubble, the bubble ends inside the thread, and the page does not scroll sideways
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

    // Then no message's actions button sits over its time, in the conversation and in the thread
    for (const text of ["Mine in the list", "Theirs in the list"]) expect(await overlap(messageLog(page), text), `${text} at ${width}`).toBe(false);
    await openThread(page, ROOT_TEXT);
    expect(await overlap(threadLog(page), "On it"), `thread reply at ${width}`).toBe(false);
    await closeThread(page);
  }
});

function test_shot(page: Page): string {
  return (page.viewportSize()?.width ?? 0) < 600 ? "/tmp/thrlist-mobile.png" : "/tmp/thrlist-chromium.png";
}

// ---- Rule: An @mention in a thread works as in the main chat (issue 35) ----------------------------------------------------------

/** The "Agents" list of the open reply box. */
const threadAgents = (page: Page): Locator => threadPane(page).getByRole("list", { name: "Agents" });

scenario("Typing @ in the reply box lists the agents and a pick mentions one", { tag: ["@browser", "@I-18"] }, async ({ server, page, context }) => {
  const t = await threadWorld({ server, page, context }, { browser: true });
  await page.goto(`${t.w.srv.origin}/chats/${t.conv}`);

  // When the owner opens the reply box of message 900 and types "@"
  await openThread(page, ROOT_TEXT);
  await replyBox(page).pressSequentially("@");

  // Then the "Agents" list shows above the reply box
  await expect(threadAgents(page)).toBeVisible();

  // When the owner picks "docs"
  await threadAgents(page).getByRole("button", { name: /@docs\b/ }).click();

  // Then the reply box holds "@docs " and keeps the focus
  await expect(replyBox(page)).toHaveValue("@docs ");
  await expect(replyBox(page)).toBeFocused();

  // When the owner types "hi-35" and sends
  await replyBox(page).pressSequentially("hi-35");
  await sendReply(page).click();

  // Then the reply shows in the thread and "docs" gets a mention item
  await expect(threadLog(page).getByRole("article").filter({ hasText: "hi-35" })).toBeVisible();
  await expect.poll(async () => (await peekFor(t.w.box, t.docsSid, t.conv)).map((i) => i.reason)).toContain("mention");
});

scenario("An agent @mentioned in a thread joins the conversation", { tag: ["@browser", "@I-18"] }, async ({ server, page, context }) => {
  // Given "release-bot" is an agent that is not in conversation 41
  const t = await threadWorld({ server, page, context }, { browser: true, agents: ["devtool", "docs", "release-bot"] });
  expect(handlesOf(await viewOf(t.w.owner, t.conv))).not.toContain("release-bot");
  await page.goto(`${t.w.srv.origin}/chats/${t.conv}`);

  // When the owner picks "release-bot" from the "Agents" list of the reply box of message 900 and sends "please review"
  await openThread(page, ROOT_TEXT);
  await replyBox(page).pressSequentially("@rel");
  await threadAgents(page).getByRole("button", { name: /@release-bot\b/ }).click();
  await replyBox(page).pressSequentially("please review");
  await sendReply(page).click();

  // Then "release-bot" is a participant of conversation 41
  await expect.poll(async () => handlesOf(await viewOf(t.w.owner, t.conv))).toContain("release-bot");
});
