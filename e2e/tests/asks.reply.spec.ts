import type { Locator, Page } from "@playwright/test";
import { streamOpen, uiWorld } from "../lib/chat-ui.ts";
import { agentPost, convoz, createConversation, inboxItems, startWatch } from "../lib/chat.ts";
import { QUESTION, agentAsks, askCard, askWorld, expectState, openNow, snoozeAsk } from "../lib/asks.ts";
import { clientId } from "../lib/machines.ts";
import { box } from "../lib/mobile.ts";
import { must } from "../lib/owner.ts";
import { expect, scenario } from "../lib/scenario.ts";
import { replyInThread, threadPane } from "../lib/threads-wp5.ts";
import { browserWorld } from "../lib/wp3.ts";

/*
 * ASK REPLIES AND THE SNOOZE SHEET (owner, conv 1 msg 1006): "Snooze ui is janked on mobile. Replying to a feed item should dismiss it and
 * the agent should have to ask it again". The bindings of the two rules added to specs/features/asks.feature after the withdrawn asks.
 */

const NOTE = "The owner replied instead of choosing. Ask again if you still need a decision.";
const DRAFT_QUESTION = "Send this reply to Alex?";

/** The buttons of a card that sit under the rectangle `r`: "label". */
const buttonsUnder = (card: Locator, r: { x: number; y: number; width: number; height: number }): Promise<string[]> =>
  card.getByRole("button").evaluateAll(
    (els, rect) =>
      els
        .filter((e) => {
          const b = e.getBoundingClientRect();
          return b.width > 0 && b.height > 0 && b.right > rect.x && b.left < rect.x + rect.width && b.bottom > rect.y && b.top < rect.y + rect.height;
        })
        .map((e) => (e.textContent || e.getAttribute("aria-label") || "").trim()),
    r,
  );

scenario("Snoozing on a phone opens a sheet that covers no button", { tag: ["@browser", "@phone"] }, async ({ server, page, context }, info) => {
  info.setTimeout(90_000);
  // Given "devtool" asked "Send this reply to Alex?" with the draft "Sounds good, Thursday works." in answer to "Can we meet Thursday?" from "Alex · Slack DM"
  const w = await browserWorld({ server, page, context }, { agents: ["devtool", "docs"], live: ["devtool"] });
  const conv = await createConversation(w.owner, { title: "Ship search filters", participants: ["devtool", "docs"] });
  const ran = await convoz(w.box, w.sessions.devtool!.sid, [
    "ask", "--json", "--draft", "Sounds good, Thursday works.", "--original", "Can we meet Thursday?", "--original-from", "Alex · Slack DM", String(conv), DRAFT_QUESTION,
  ]);
  expect({ code: ran.code, stderr: ran.stderr }).toEqual({ code: 0, stderr: "" });

  // And the owner opens Now on a phone
  await openNow(page, w.srv);
  const card = askCard(page, DRAFT_QUESTION);
  await expect(card.getByRole("textbox", { name: "Draft" })).toBeVisible();
  const snooze = card.getByRole("group", { name: "Ask actions" }).getByRole("button", { name: "Snooze" });
  const menu = page.getByRole("menu");
  const view = page.viewportSize()!;

  // When the owner taps "Snooze" on the card
  await snooze.click();

  // Then a sheet with "1 hour", "Tomorrow" and "Cancel" opens at the bottom of the screen
  for (const name of ["1 hour", "Tomorrow", "Cancel"]) await expect(menu.getByRole("menuitem", { name })).toBeVisible();
  const sheet = await box(menu);
  expect({ left: Math.round(sheet.x), width: Math.round(sheet.width), bottom: Math.round(sheet.y + sheet.height) }).toEqual({ left: 0, width: view.width, bottom: view.height });

  // And the sheet covers no button of the card
  await expect.poll(async () => buttonsUnder(card, await box(menu))).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

  // And the sheet is shown in dark and in light
  for (const scheme of ["dark", "light"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await expect(menu).toBeVisible();
    await page.screenshot({ path: `/tmp/askreply-snooze-sheet-${scheme}.png` });
  }

  // When the owner taps outside the sheet
  await page.touchscreen.tap(view.width / 2, 24);

  // Then the sheet closes
  await expect(menu).toHaveCount(0);

  // When the owner taps "Snooze" and then "Cancel"
  await snooze.click();
  await menu.getByRole("menuitem", { name: "Cancel" }).click();

  // Then the sheet closes and the ask is still in Now
  await expect(menu).toHaveCount(0);
  await expect(card).toBeVisible();

  // When the owner taps "Snooze" and then "1 hour"
  await snooze.click();
  await menu.getByRole("menuitem", { name: "1 hour" }).click();

  // Then the sheet closes and Now no longer lists the ask
  await expect(menu).toHaveCount(0);
  await expect(card).toHaveCount(0);
});

scenario("Replying to an ask closes it and the agent must ask again", { tag: ["@browser"] }, async ({ server, page, context }, info) => {
  info.setTimeout(90_000);
  // Given an open ask of "devtool", and the owner has the conversation and Now open in two pages
  const u = await uiWorld({ server, page, context }, { agents: ["devtool"], live: ["devtool"] });
  const lease = u.sessions.devtool!.lease;
  const conv = await createConversation(u.w.owner, { title: "Ship search filters", participants: ["devtool"] });
  const id = await agentAsks(u.w.srv, lease, conv);
  await page.goto(`${u.w.srv.origin}/chats/${conv}`);
  await expect(askCard(page).getByRole("button", { name: "Quick reply" })).toBeVisible();
  const now: Page = await context.newPage();
  await openNow(now, u.w.srv);
  await expect(askCard(now)).toBeVisible();
  await streamOpen(page);
  await streamOpen(now);

  // When the owner replies to the ask in its thread
  await askCard(page).getByRole("button", { name: "Reply in thread" }).click();
  await threadPane(page).waitFor();
  await replyInThread(page, "Use the smaller one");

  // Then Now no longer lists it and the card in the conversation shows "Answered with a reply", with no reload
  await expect(askCard(now)).toHaveCount(0, { timeout: 4_000 });
  await expect(askCard(page).first()).toContainText("Answered with a reply", { timeout: 4_000 });
  await expect(askCard(page).first().getByRole("button", { name: "Quick reply" })).toHaveCount(0);
  expect(await expectState(u.w.owner, id)).toBe("closed (replied)");

  // And "devtool" has to ask again: the same question opens as a new ask
  const again = await agentAsks(u.w.srv, lease, conv);
  expect(again).not.toBe(id);
  await expect(askCard(now)).toBeVisible({ timeout: 4_000 });
  await expect(now.getByRole("article", { name: QUESTION })).toHaveCount(1);
});

scenario("An agent's reply does not close an ask", { tag: ["@cli"] }, async ({ server }) => {
  // Given an open ask of "devtool"
  const { w, conv, devtool, docs } = await askWorld(server);
  const id = await agentAsks(w.srv, devtool.lease, conv);

  // When "docs" replies in the thread of the ask
  must(await agentPost(w.srv, docs.lease, conv, "Any thoughts?", { thread_root_id: id }), "docs replies in the thread of the ask", 201);

  // And "devtool" replies in the thread of the ask
  must(await agentPost(w.srv, devtool.lease, conv, "Still waiting", { thread_root_id: id }), "devtool replies in the thread of the ask", 201);

  // Then the ask is still open
  expect(await expectState(w.owner, id)).toBe("open");
});

scenario("An agent sees that the owner replied instead of choosing", { tag: ["@cli"] }, async ({ server }) => {
  // Given an open ask of "devtool" that the owner then snoozed
  const { w, conv, devtool } = await askWorld(server);
  const id = await agentAsks(w.srv, devtool.lease, conv);
  must(await snoozeAsk(w.owner, id, { preset: "1h" }), "snooze");

  // When the owner replies in the thread of the ask
  must(await w.owner.client.post(`/api/conversations/${conv}/messages`, { client_id: clientId(), body: "Use the smaller one", thread_root_id: id }), "owner replies in the thread", 201);

  // Then the ask is closed because the owner replied
  expect(await expectState(w.owner, id)).toBe("closed (replied)");

  // And "devtool" reads in its inbox and in its watch: "The owner replied instead of choosing. Ask again if you still need a decision."
  const item = (await inboxItems(w.box, devtool.sid, ["--peek"])).find((i) => i.reason === "ask_resolved") as unknown as { message: { id: number; ask: { close_reason: string } } };
  expect({ ask: item.message.id, reason: item.message.ask.close_reason }).toEqual({ ask: id, reason: "replied" });
  const peek = await convoz(w.box, devtool.sid, ["inbox", "--peek"]);
  expect(peek.stdout).toContain(NOTE);
  const watch = startWatch(w.box, devtool.sid);
  try {
    await watch.waitForStdout(/ask_resolved/, 10_000);
    const lines = watch.stdout().split("\n").filter(Boolean).map((l) => JSON.parse(l) as { reason: string; note?: string });
    expect(lines.find((l) => l.reason === "ask_resolved")?.note).toBe(NOTE);
  } finally {
    await watch.stop();
  }
});
