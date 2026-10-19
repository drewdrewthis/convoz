import { agentSays, convoz, createConversation, ownerSays, unreadOf } from "../lib/chat.ts";
import {
  QUESTION,
  agentAsks,
  answerAsk,
  askCard,
  markAsk,
  askOf,
  askWorld,
  nowOf,
  openFold,
  openNow,
  setServerTime,
  snoozeAsk,
} from "../lib/asks.ts";
import { setPrefs } from "../lib/rail-wp9.ts";
import { mintSession, nowCard, plainDb, requestMachine, seedUserCodes } from "../lib/machines.ts";
import { must } from "../lib/owner.ts";
import type { Locator, Page } from "@playwright/test";
import { expect, scenario, test } from "../lib/scenario.ts";
import { asAgent, browserWorld, idsOf, rowsOnList } from "../lib/wp3.ts";

/*
 * NOW (WP8): the bindings of specs/features/now.feature and specs/contracts/now.feature. The page contract (role and text locators only):
 *   Now (/)         heading "Now"; the top bar says "N open" (#open-count): the asks, pending adds and machine requests that wait.
 *   an ask          an article named by its question; it shows "Display Name @handle" and the conversation title; one button per option
 *                   named by its label; buttons "Quick reply" (a textbox "Quick reply" and "Send"), "Snooze" (a menu with "1 hour",
 *                   "Tonight", "Tomorrow"), "Dismiss". Keys with the card focused: Enter recommended, A alternative, R quick reply,
 *                   S snooze, X dismiss; J and K move between cards.
 *   folds           buttons "Snoozed" and "Answered today" (aria-expanded) with rows: "Snoozed until <time>" and an "Unsnooze" button;
 *                   "Answered · <label>" or "Replied · <text>". Answering from Now opens "Answered today".
 *   a pending add   an article "<Name @handle> wants to add <Name @handle>" with Approve and Decline.
 *   a machine       an article "<name> wants to connect" with its code; /now/machine/:id brings its card into view; Approve and Decline are one tap each (no sheet, no passkey).
 *   the badge       navigator.setAppBadge(open asks that are not snoozed) when the page is hidden.
 * The browser's time zone is America/New_York: Tonight and Tomorrow are read there, against the server's clock.
 */

test.use({ timezoneId: "America/New_York" });

const WORLD = { agents: ["devtool", "docs", "release-bot"], live: ["devtool", "docs"] };
const NY = (local: string) => Date.parse(`${local}-04:00`); // October 2026 in New York is UTC-4

// ---- now.feature ----------------------------------------------------------------------------------------------

scenario("Urgent asks come before other asks", { tag: ["@browser"] }, async ({ server, page, context, dataDir, testApi }, info) => {
  info.setTimeout(90_000);
  // Given "devtool" asked "Merge #415 on its own?" and then "docs" asked an urgent "Roll back box-3?"
  const w = await browserWorld({ server, page, context }, WORLD);
  const conv = await createConversation(w.owner, { title: "Ship search filters", participants: ["devtool", "docs"] });
  await agentAsks(w.srv, w.sessions.devtool!.lease, conv);
  await agentAsks(w.srv, w.sessions.docs!.lease, conv, { question: "Roll back box-3?", urgent: true, rec: ["Roll back", "Error rate doubled"], alts: [["Keep it", "Watch one more hour"]] });

  // When the owner opens Now
  await openNow(page, w.srv);

  // Then "Roll back box-3?" is listed first
  await expect(page.getByRole("article")).toHaveCount(2);
  await expect(page.getByRole("article").first()).toHaveAccessibleName("Roll back box-3?");

  // And each ask shows the agent as "Display Name @handle" and the conversation title
  await expect(askCard(page, "Roll back box-3?")).toContainText("Docs @docs");
  await expect(askCard(page, QUESTION)).toContainText("Devtool @devtool");
  await expect(askCard(page, QUESTION)).toContainText("Ship search filters");
  await expect(askCard(page, "Roll back box-3?")).toContainText("Ship search filters");
});

scenario("Now shows pending adds and machine requests next to asks", { tag: ["@browser"] }, async ({ server, page, context, dataDir, testApi }, info) => {
  info.setTimeout(90_000);
  // Given "devtool" requested to add "@release-bot" to conversation 41
  const w = await browserWorld({ server, page, context }, WORLD);
  const conv = await createConversation(w.owner, { title: "Ship search filters", participants: ["devtool", "docs"] });
  must(await asAgent(w.srv, w.sessions.devtool!.lease, "POST", `/api/conversations/${conv}/participants`, { handle: "release-bot" }), "request the add", 201);

  // And a machine request "box-9" with the code "PLRT-HXCV" is pending
  await seedUserCodes(w.srv, ["PLRT-HXCV"]);
  await requestMachine(w.srv, w.owner, "box-9");

  // When the owner opens Now
  await openNow(page, w.srv);

  // Then Now shows the pending add with Approve and Decline
  const add = page.getByRole("article", { name: /wants to add/ });
  await expect(add).toContainText("Devtool @devtool wants to add Release-bot @release-bot");
  await expect(add).toContainText("Ship search filters");
  await expect(add.getByRole("button", { name: "Approve", exact: true })).toBeVisible();
  await expect(add.getByRole("button", { name: "Decline", exact: true })).toBeVisible();

  // And Now shows the machine request card with the code "PLRT-HXCV"
  await expect(nowCard(page, "box-9")).toContainText("PLRT-HXCV");
});

scenario("The badge counts open asks that are not snoozed", { tag: ["@browser", "@phone"] }, async ({ server, page, context, dataDir, testApi }, info) => {
  info.setTimeout(90_000);
  // Given 3 open asks and 1 of them snoozed
  await context.addInitScript(() => {
    const calls: number[] = [];
    (window as unknown as { __badge: number[] }).__badge = calls;
    Object.defineProperty(navigator, "setAppBadge", { configurable: true, value: (n?: number) => (calls.push(n ?? 0), Promise.resolve()) });
    Object.defineProperty(navigator, "clearAppBadge", { configurable: true, value: () => (calls.push(0), Promise.resolve()) });
  });
  const w = await browserWorld({ server, page, context }, WORLD);
  const conv = await createConversation(w.owner, { title: "Ship search filters", participants: ["devtool", "docs"] });
  const ids = [];
  for (const q of ["First?", "Second?", "Third?"]) ids.push(await agentAsks(w.srv, w.sessions.devtool!.lease, conv, { question: q }));
  must(await snoozeAsk(w.owner, ids[0]!, { preset: "1h" }), "snooze one");
  expect((await nowOf(w.owner)).badge).toBe(2);

  // When the installed app is in the background
  await openNow(page, w.srv);
  await expect(page.getByRole("article")).toHaveCount(2);
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
    document.dispatchEvent(new Event("visibilitychange"));
  });

  // Then the app badge shows 2
  await expect.poll(() => page.evaluate(() => (window as unknown as { __badge: number[] }).__badge.at(-1))).toBe(2);
});

scenario("Answering from Now does not mark the conversation read", { tag: ["@browser"] }, async ({ server, page, context, dataDir, testApi }, info) => {
  info.setTimeout(150_000);
  const w = await browserWorld({ server, page, context }, WORLD);
  const rows: [string, string, string][] = [
    ["the recommended \"Merge it\"", "Answered · Merge it", "Merge it"],
    ["the alternative \"Hold it\"", "Answered · Hold it", "Hold it"],
    ["the quick reply \"Split in two\"", "Replied · Split in two", "Split in two"],
  ];
  for (const [choice, result, label] of rows) {
    // Given conversation 41 has 4 unread messages and an open ask "Merge #415 on its own?"
    const conv = await createConversation(w.owner, { title: `Ship search filters ${label}`, participants: ["devtool", "docs"] });
    for (const text of ["Checks are green", "Reviewers approved", "Rebased on main"]) await agentSays(w.srv, w.sessions.devtool!.lease, conv, text);
    await agentAsks(w.srv, w.sessions.devtool!.lease, conv);
    expect(await unreadOf(w.owner, conv), `${choice}: unread before`).toBe(4);

    // When the owner answers from Now with <choice>
    await openNow(page, w.srv);
    const card = askCard(page);
    if (label === "Split in two") {
      await card.getByRole("button", { name: "Quick reply" }).click();
      await card.getByRole("textbox", { name: "Quick reply" }).fill(label);
      await card.getByRole("button", { name: "Send", exact: true }).click();
    } else {
      await card.getByRole("button", { name: label, exact: true }).click();
    }

    // Then the ask shows "<result>"
    await expect(page.getByText(result)).toBeVisible();

    // And conversation 41 still shows 4 unread in the rail
    expect(await unreadOf(w.owner, conv), `${choice}: unread after`).toBe(4);
    await page.goto(`${w.srv.origin}/chats`);
    await expect(rowsOnList(page).filter({ hasText: `Ship search filters ${label}` })).toContainText(/Unread:\s*4/);
  }
});

scenario("Dismiss removes an ask from Now", { tag: ["@browser"] }, async ({ server, page, context, dataDir, testApi }, info) => {
  info.setTimeout(90_000);
  // Given an open ask of "devtool"
  const w = await browserWorld({ server, page, context }, WORLD);
  const conv = await createConversation(w.owner, { title: "Ship search filters", participants: ["devtool", "docs"] });
  const id = await agentAsks(w.srv, w.sessions.devtool!.lease, conv);
  await openNow(page, w.srv);

  // When the owner dismisses it
  await askCard(page).getByRole("button", { name: "Dismiss" }).click();

  // Then Now no longer lists it
  await expect(askCard(page)).toHaveCount(0);
  expect((await nowOf(w.owner)).asks).toEqual([]);

  // And the ask in conversation 41 shows "Dismissed"
  await page.goto(`${w.srv.origin}/chats/${conv}`);
  await expect(askCard(page)).toContainText("Dismissed");
  expect((await askOf(w.owner, id)).state).toBe("dismissed");
});

scenario("Dismiss shows an Undo toast and Undo puts the ask back", { tag: ["@browser"] }, async ({ server, page, context }, info) => {
  info.setTimeout(90_000);
  // Given an open ask of "devtool"
  const w = await browserWorld({ server, page, context }, WORLD);
  const conv = await createConversation(w.owner, { title: "Ship search filters", participants: ["devtool", "docs"] });
  const id = await agentAsks(w.srv, w.sessions.devtool!.lease, conv);
  await openNow(page, w.srv);

  // When the owner dismisses it
  await askCard(page).getByRole("button", { name: "Dismiss" }).click();

  // Then a toast says "Dismissed" with an Undo button for 10 seconds
  const toast = page.getByRole("status").filter({ hasText: "Dismissed" });
  await expect(toast).toBeVisible();
  await expect(toast.getByRole("button", { name: "Undo" })).toBeVisible();

  // When the owner taps Undo
  await toast.getByRole("button", { name: "Undo" }).click();

  // Then Now lists the ask as open again
  await expect(askCard(page)).toHaveCount(1);
  expect((await askOf(w.owner, id)).state).toBe("open");
});

scenario("The Dismissed fold lists dismissed asks and Reopen puts one back", { tag: ["@browser"] }, async ({ server, page, context }, info) => {
  info.setTimeout(90_000);
  // Given an open ask of "devtool" that the owner dismissed
  const w = await browserWorld({ server, page, context }, WORLD);
  const conv = await createConversation(w.owner, { title: "Ship search filters", participants: ["devtool", "docs"] });
  const id = await agentAsks(w.srv, w.sessions.devtool!.lease, conv);
  await openNow(page, w.srv);
  await askCard(page).getByRole("button", { name: "Dismiss" }).click();
  await expect(askCard(page)).toHaveCount(0);

  // When the owner opens "Dismissed today" in Now
  await page.getByRole("button", { name: /^Dismissed today/ }).click();

  // Then it lists the ask as "Dismissed" with a "Reopen" button
  const row = page.locator(".foldrows li");
  await expect(row).toContainText("Dismissed");

  // When the owner taps "Reopen"
  await row.getByRole("button", { name: "Reopen" }).click();

  // Then Now lists the ask as open again
  await expect(askCard(page)).toHaveCount(1);
  expect((await askOf(w.owner, id)).state).toBe("open");
});

/** The quick bar of an open ask: Snooze and Dismiss always, Quick reply where the card is not in a thread. Each button is on screen. */
async function expectBar(page: Page, scope: Locator, withReply: boolean): Promise<void> {
  const bar = scope.getByRole("group", { name: "Ask actions" });
  const width = page.viewportSize()?.width ?? 0;
  const names = withReply ? ["Quick reply", "Snooze", "Dismiss"] : ["Snooze", "Dismiss"];
  for (const name of names) {
    const b = bar.getByRole("button", { name, exact: true });
    await expect(b).toBeVisible();
    const box = (await b.boundingBox())!;
    expect(box.x >= 0 && box.x + box.width <= width, `${name} is on screen`).toBe(true);
  }
  if (!withReply) await expect(bar.getByRole("button", { name: "Quick reply", exact: true })).toHaveCount(0);
}

scenario("With nothing waiting, the feed centres the wordmark, the all-clear line under it, and the folds", { tag: ["@browser"] }, async ({ server, page, context }, info) => {
  info.setTimeout(90_000);
  // Given conversation 41 has an answered ask and a dismissed ask, and nothing else waits
  const w = await browserWorld({ server, page, context }, WORLD);
  const conv = await createConversation(w.owner, { title: "Ship search filters", participants: ["devtool", "docs"] });
  const lease = w.sessions.devtool!.lease;
  must(await answerAsk(w.owner, await agentAsks(w.srv, lease, conv, { question: "Answered question?" })), "answer");
  must(await markAsk(w.owner, await agentAsks(w.srv, lease, conv, { question: "Dismissed question?" }), "dismiss"), "dismiss");
  // Owner, conv 1, msg 535: unread messages now show on Now instead of "All clear", so for all clear the asks' messages are read
  must(await w.owner.client.post(`/api/conversations/${conv}/read`, { main_id: 0, all: true }), "read it all");

  // When the owner opens Now
  await openNow(page, w.srv);
  const clear = page.getByText("All clear. Nothing needs you.");
  await expect(clear).toBeVisible();
  await expect(page.getByRole("button", { name: /^Dismissed today/ })).toBeVisible();

  // Then the wordmark, "All clear. Nothing needs you." and the fold chips are centred in the page column, in that order from the top
  const vp = page.viewportSize()!;
  const mid = async (l: Locator) => {
    const b = (await l.boundingBox())!;
    return { x: b.x + b.width / 2, y: b.y };
  };
  const wordmark = await mid(page.locator("#allclear .wordmark svg"));
  const line = await mid(page.locator("#allclear .allclear"));
  const chips = await mid(page.locator(".foldchips"));
  const col = (await page.locator("#allclear").boundingBox())!;
  const colMid = col.x + col.width / 2;
  for (const [name, at] of [["wordmark", wordmark], ["all-clear line", line], ["fold chips", chips]] as const) {
    expect(Math.abs(at.x - colMid), `${name} is centred`).toBeLessThanOrEqual(2);
  }
  expect(wordmark.y, "wordmark is above the line").toBeLessThan(line.y);
  expect(line.y, "line is above the chips").toBeLessThan(chips.y);

  // And the page does not scroll sideways
  const fits = () => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
  expect(await fits()).toBe(true);
  await page.setViewportSize({ width: 320, height: 700 });
  expect(await fits(), "no sideways scroll at 320 px").toBe(true);
  await page.setViewportSize(vp);
});

// Owner, conv 1, msg 535: "hmm, it says nothing needs me, but there are a lot of unseen responses.. i'm wondering if there's a better way for that to be handled"
// Msg 562: "hmm, probably you can come up with a good ui/ux for that that really makes the absorbtion of info quick an easy"
async function unreadWorld(
  { server, page, context }: Pick<Parameters<Parameters<typeof scenario>[2]>[0], "server" | "page" | "context">,
  say: string[],
  muted = false,
) {
  const w = await browserWorld({ server, page, context }, WORLD);
  const conv = await createConversation(w.owner, { title: "Ship search filters", participants: ["devtool", "docs"] });
  for (const text of say) await agentSays(w.srv, w.sessions.devtool!.lease, conv, text);
  if (muted) await setPrefs(w.owner, conv, { muted_until: 253402300799000 });
  return { w, conv };
}

scenario("With no decisions but unread conversations, Now lists them instead of saying all clear", { tag: ["@browser"] }, async ({ server, page, context }, info) => {
  info.setTimeout(90_000);
  // Given no decision waits and "devtool" posted 5 messages in conversation 41 that the owner has not read
  const { w } = await unreadWorld({ server, page, context }, ["News 1", "News 2", "News 3", "News 4", "News 5"]);

  // When the owner opens Now
  await openNow(page, w.srv);

  // Then Now says "No decisions waiting" and not "All clear. Nothing needs you."
  await expect(page.getByText("No decisions waiting")).toBeVisible();
  await expect(page.getByText("All clear. Nothing needs you.")).toBeHidden();

  // And the wordmark is not shown, so the cards sit near the top
  await expect(page.locator(".wordmark")).toBeHidden();
  await expect(page.getByRole("list", { name: "Unread conversations" })).toBeInViewport();

  // And a summary line says "5 unread in 1 conversation"
  await expect(page.getByText("5 unread in 1 conversation", { exact: true })).toBeVisible();

  // And conversation 41 has one card with its title, an unread count of 5 and a short age
  const card = page.getByRole("list", { name: "Unread conversations" }).getByRole("listitem");
  await expect(card).toHaveCount(1);
  await expect(card.getByRole("heading")).toHaveText("Ship search filters");
  await expect(card.locator(".count")).toHaveText("Unread: 5");
  await expect(card.locator("time")).toHaveText(/^(now|\d+m)$/);

  // And the card shows only the 3 newest unread lines, newest first, each with its author
  const lines = card.locator(".uline");
  await expect(lines).toHaveText(["devtool News 5", "devtool News 4", "devtool News 3"]);
});

scenario("Marking all read from Now clears the list and shows all clear", { tag: ["@browser"] }, async ({ server, page, context }, info) => {
  info.setTimeout(90_000);
  // Given no decision waits and "devtool" posted 2 messages in conversation 41 that the owner has not read
  const { w, conv } = await unreadWorld({ server, page, context }, ["First news", "Latest news"]);

  // When the owner opens Now and taps "Mark all read"
  await openNow(page, w.srv);
  await page.getByRole("button", { name: "Mark all read" }).click();

  // Then the Unread list is gone and Now says "All clear. Nothing needs you."
  await expect(page.getByRole("list", { name: "Unread conversations" })).toHaveCount(0);
  await expect(page.getByText("All clear. Nothing needs you.")).toBeVisible();
  expect(await unreadOf(w.owner, conv)).toBe(0);
});

scenario("A muted conversation is not listed under Unread", { tag: ["@browser"] }, async ({ server, page, context }, info) => {
  info.setTimeout(90_000);
  // Given no decision waits and "devtool" posted 2 messages in a muted conversation 41 that the owner has not read
  const { w } = await unreadWorld({ server, page, context }, ["First news", "Latest news"], true);

  // When the owner opens Now
  await openNow(page, w.srv);

  // Then Now says "All clear. Nothing needs you." and has no Unread list
  await expect(page.getByText("All clear. Nothing needs you.")).toBeVisible();
  await expect(page.getByRole("list", { name: "Unread conversations" })).toHaveCount(0);
});

scenario("Opening an unread row lands at the first unread message", { tag: ["@browser"] }, async ({ server, page, context }, info) => {
  info.setTimeout(90_000);
  // Given no decision waits and "devtool" posted "First news", "Second news" and "Third news" in conversation 41 that the owner has not read
  const { w, conv } = await unreadWorld({ server, page, context }, ["First news", "Second news", "Third news"]);

  // When the owner opens Now and taps the conversation 41 row under Unread
  await openNow(page, w.srv);
  await page.getByRole("list", { name: "Unread conversations" }).getByRole("link", { name: /Ship search filters/ }).click();
  await expect(page).toHaveURL(`${w.srv.origin}/chats/${conv}`);

  // Then conversation 41 opens with the "New messages" line above "First news"
  const line = page.getByRole("separator", { name: "New messages" });
  await expect(line).toBeVisible();
  const first = page.getByText("First news", { exact: true });
  await expect(first).toBeVisible();
  expect((await line.boundingBox())!.y).toBeLessThan((await first.boundingBox())!.y);
});

scenario("The Now item shows how many items wait in the feed and updates live", { tag: ["@browser"] }, async ({ server, page, context }, info) => {
  info.setTimeout(90_000);
  // Given 2 open asks, 1 snoozed ask and 1 answered ask
  const w = await browserWorld({ server, page, context }, WORLD);
  const conv = await createConversation(w.owner, { title: "Ship search filters", participants: ["devtool", "docs"] });
  const lease = w.sessions.devtool!.lease;
  const open = [await agentAsks(w.srv, lease, conv, { question: "First?" }), await agentAsks(w.srv, lease, conv, { question: "Second?" })];
  must(await snoozeAsk(w.owner, await agentAsks(w.srv, lease, conv, { question: "Snoozed?" }), { preset: "1h" }), "snooze");
  must(await answerAsk(w.owner, await agentAsks(w.srv, lease, conv, { question: "Answered?" })), "answer");

  // When the owner opens Now
  await openNow(page, w.srv);

  // Then the Now item in the rail and the Now tab on a phone show 2
  const badge = page.locator(".rbadge:visible, #now-badge:visible");
  await expect(badge).toHaveText("2");

  // When the owner answers one ask
  must(await answerAsk(w.owner, open[0]!), "answer one");

  // Then the Now item shows 1
  await expect(badge).toHaveText("1");

  // When the owner answers the last ask
  must(await answerAsk(w.owner, open[1]!), "answer last");

  // Then the Now item shows no count
  await expect(badge).toHaveCount(0);
});

scenario("After approving a new agent the card offers a message to it", { tag: ["@browser"] }, async ({ server, page, context }, info) => {
  info.setTimeout(90_000);
  // Given an agent asked to connect as "dev-ci" from the machine "box-2"
  const w = await browserWorld({ server, page, context }, WORLD);
  must(await mintSession(w.srv, w.box2.key, { as: "dev-ci", create: { description: "Runs CI" } }), "identity request", 202);

  // When the owner opens Now and taps Approve
  await openNow(page, w.srv);
  await page.getByRole("article", { name: "box-2 wants to connect as @dev-ci", exact: true }).getByRole("button", { name: "Approve", exact: true }).click();

  // Then the card reads "@dev-ci joined" with a "Message @dev-ci" button
  const card = page.getByRole("article", { name: "@dev-ci joined", exact: true });
  await expect(card).toBeVisible();
  const message = card.getByRole("link", { name: "Message @dev-ci", exact: true });
  await expect(message).toBeVisible();

  // When the owner taps "Message @dev-ci"
  await message.click();

  // Then a new conversation opens with @dev-ci tagged and the cursor in the composer
  await expect(page).toHaveURL(/\/chats\/new\?with=dev-ci$/);
  await expect(page.locator("textarea:focus")).toBeVisible();
  await expect(page.getByText("@dev-ci").first()).toBeVisible();
});

scenario("Every item in the feed opens its conversation when tapped", { tag: ["@browser"] }, async ({ server, page, context }, info) => {
  info.setTimeout(120_000);
  // Given conversation 41 has a snoozed ask, an answered ask and a dismissed ask
  const w = await browserWorld({ server, page, context }, WORLD);
  const conv = await createConversation(w.owner, { title: "Ship search filters", participants: ["devtool", "docs"] });
  const lease = w.sessions.devtool!.lease;
  const snoozedId = await agentAsks(w.srv, lease, conv, { question: "Snoozed question?" });
  must(await snoozeAsk(w.owner, snoozedId, { preset: "1h" }), "snooze");
  const answeredId = await agentAsks(w.srv, lease, conv, { question: "Answered question?" });
  must(await answerAsk(w.owner, answeredId), "answer");
  const dismissedId = await agentAsks(w.srv, lease, conv, { question: "Dismissed question?" });
  must(await markAsk(w.owner, dismissedId, "dismiss"), "dismiss");

  // When the owner opens each fold in Now and taps the ask in it
  for (const [fold, question, id] of [["Snoozed", "Snoozed question?", snoozedId], ["Answered today", "Answered question?", answeredId], ["Dismissed today", "Dismissed question?", dismissedId]] as const) {
    await openNow(page, w.srv);
    await openFold(page, fold);
    await page.locator(".foldrows li").filter({ hasText: question }).getByRole("link", { name: question }).click();

    // Then conversation 41 opens with that ask in view
    await expect(page).toHaveURL(new RegExp(`/chats/${conv}#m${id}$`));
    await expect(askCard(page, question)).toBeInViewport();
  }
});

scenario("Reopen puts a dismissed ask back on a phone", { tag: ["@browser"] }, async ({ server, page, context }, info) => {
  info.setTimeout(120_000);
  // Given an open ask of "devtool" that the owner dismissed
  const w = await browserWorld({ server, page, context }, WORLD);
  const conv = await createConversation(w.owner, { title: "Ship search filters", participants: ["devtool", "docs"] });
  const id = await agentAsks(w.srv, w.sessions.devtool!.lease, conv);
  must(await markAsk(w.owner, id, "dismiss"), "dismiss");

  // When the owner opens "Dismissed today" in Now and taps "Reopen"
  await openNow(page, w.srv);
  await openFold(page, "Dismissed today");
  await page.locator(".foldrows li").getByRole("button", { name: "Reopen" }).click();

  // Then Now lists the ask as open again with its quick bar
  await expect(askCard(page)).toHaveCount(1);
  expect((await askOf(w.owner, id)).state).toBe("open");
  await expectBar(page, askCard(page), true);

  // When the owner dismisses it and reopens it from the ask options in conversation 41
  must(await markAsk(w.owner, id, "dismiss"), "dismiss again");
  await page.goto(`${w.srv.origin}/chats/${conv}`);
  await askCard(page).getByRole("button", { name: "Ask options" }).click();
  await page.getByRole("menuitem", { name: "Reopen" }).click();

  // Then the ask in conversation 41 shows its quick bar
  await expectBar(page, askCard(page), true);
  expect((await askOf(w.owner, id)).state).toBe("open");
});

scenario("An open ask always shows its quick bar", { tag: ["@browser"] }, async ({ server, page, context }, info) => {
  info.setTimeout(180_000);
  const w = await browserWorld({ server, page, context }, WORLD);
  const lease = w.sessions.devtool!.lease;
  const fresh = async (title: string) => {
    const conv = await createConversation(w.owner, { title, participants: ["devtool", "docs"] });
    return { conv, id: await agentAsks(w.srv, lease, conv) };
  };

  // | in Now | in Now |
  const a = await fresh("Row now");
  await openNow(page, w.srv);
  await expectBar(page, askCard(page), true);

  // | in conversation 41 | in conversation 41 |
  await page.goto(`${w.srv.origin}/chats/${a.conv}`);
  await expectBar(page, askCard(page), true);

  // | in conversation 41 | in its thread |
  await askCard(page).getByRole("button", { name: "Reply in thread", exact: true }).click();
  await expectBar(page, page.getByRole("log", { name: "Thread messages" }), false);

  // | in conversation 41 | in conversation 41 after a reload |
  await page.goto(`${w.srv.origin}/chats/${a.conv}`);
  await page.reload();
  await expectBar(page, askCard(page), true);

  // | that was dismissed | in Now after "Reopen" |
  must(await markAsk(w.owner, a.id, "dismiss"), "dismiss");
  await openNow(page, w.srv);
  await openFold(page, "Dismissed today");
  await page.locator(".foldrows li").getByRole("button", { name: "Reopen" }).click();
  await expectBar(page, askCard(page), true);

  // | that was snoozed | in Now after "Unsnooze" |
  must(await snoozeAsk(w.owner, a.id, { preset: "1h" }), "snooze");
  await page.reload();
  await openFold(page, "Snoozed");
  await page.locator(".foldrows li").getByRole("button", { name: "Unsnooze" }).click();
  await expectBar(page, askCard(page), true);

  // | in Now | in Now after a reload |
  await page.reload();
  await expectBar(page, askCard(page), true);
  await expect(askCard(page).getByRole("group", { name: "Ask actions" })).toBeVisible();
});

scenario("An answered ask in the feed lets the owner follow up in its thread or jump to its conversation", { tag: ["@browser"] }, async ({ server, page, context }, info) => {
  info.setTimeout(120_000);
  // Given an answered ask, a dismissed ask and a snoozed ask of "devtool"
  const w = await browserWorld({ server, page, context }, WORLD);
  const conv = await createConversation(w.owner, { title: "Ship search filters", participants: ["devtool", "docs"] });
  const lease = w.sessions.devtool!.lease;
  const answeredId = await agentAsks(w.srv, lease, conv, { question: "Answered question?" });
  must(await answerAsk(w.owner, answeredId), "answer");
  must(await markAsk(w.owner, await agentAsks(w.srv, lease, conv, { question: "Dismissed question?" }), "dismiss"), "dismiss");
  must(await snoozeAsk(w.owner, await agentAsks(w.srv, lease, conv, { question: "Snoozed question?" }), { preset: "1h" }), "snooze");

  // When the owner opens the folds in Now
  await openNow(page, w.srv);
  for (const fold of ["Snoozed", "Answered today", "Dismissed today"]) await openFold(page, fold);

  // Then each row offers "Reply in thread" and "Jump to conversation"
  const rows = page.locator(".foldrows li");
  await expect(rows).toHaveCount(3);
  for (const row of await rows.all()) {
    await expect(row.getByRole("link", { name: "Reply in thread", exact: true })).toBeVisible();
    await expect(row.getByRole("link", { name: "Jump to conversation", exact: true })).toBeVisible();
  }

  // When the owner taps "Reply in thread" on the answered row
  const answered = rows.filter({ hasText: "Answered question?" });
  await answered.getByRole("link", { name: "Reply in thread", exact: true }).click();

  // Then the thread of the ask opens and its Reply box has focus
  await expect(page.getByRole("textbox", { name: "Reply in thread" })).toBeFocused();

  // When the owner taps "Jump to conversation" on the answered row
  await openNow(page, w.srv);
  await openFold(page, "Answered today");
  await page.locator(".foldrows li").getByRole("link", { name: "Jump to conversation", exact: true }).click();

  // Then conversation 41 opens with the ask in view and the ask is still answered
  await expect(page).toHaveURL(new RegExp(`/chats/${conv}#m${answeredId}$`));
  await expect(askCard(page, "Answered question?")).toBeInViewport();
  expect((await askOf(w.owner, answeredId)).state).toBe("answered");
});

scenario("The ask bar works from the keyboard", { tag: ["@browser"] }, async ({ server, page, context, dataDir, testApi }, info) => {
  info.setTimeout(90_000);
  // Given an open ask of "devtool" has focus in Now
  const w = await browserWorld({ server, page, context }, WORLD);
  const conv = await createConversation(w.owner, { title: "Ship search filters", participants: ["devtool", "docs"] });
  const older = await agentAsks(w.srv, w.sessions.devtool!.lease, conv, { question: "Older question?" });
  const newer = await agentAsks(w.srv, w.sessions.devtool!.lease, conv, { question: "Newer question?" });
  await openNow(page, w.srv);
  await expect(page.getByRole("article")).toHaveCount(2);
  await askCard(page, "Newer question?").focus();

  // When the owner presses "S" and picks "1 hour"
  await page.keyboard.press("s");
  await page.getByRole("menuitem", { name: "1 hour" }).click();

  // Then the ask moves to snoozed
  await expect(askCard(page, "Newer question?")).toHaveCount(0);
  await openFold(page, "Snoozed");
  expect((await nowOf(w.owner)).snoozed.map((a) => a.id)).toEqual([newer]);

  // And pressing "X" on the next ask dismisses it
  await expect(askCard(page, "Older question?")).toBeFocused();
  await page.keyboard.press("x");
  await expect(askCard(page, "Older question?")).toHaveCount(0);
  expect((await askOf(w.owner, older)).state).toBe("dismissed");
});

scenario("A losing answer shows what won", { tag: ["@browser"] }, async ({ server, page, context, dataDir, testApi }, info) => {
  info.setTimeout(90_000);
  // Given an open ask of "devtool" is open in two browsers
  const w = await browserWorld({ server, page, context }, WORLD);
  const conv = await createConversation(w.owner, { title: "Ship search filters", participants: ["devtool", "docs"] });
  const id = await agentAsks(w.srv, w.sessions.devtool!.lease, conv);
  const second = await context.newPage();
  await openNow(page, w.srv);
  await openNow(second, w.srv);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  await second.route(`**/api/asks/${id}/answer`, async (route) => {
    await gate;
    await route.continue();
  });

  // When one browser answers "Merge it" and the other then answers "Hold it"
  await askCard(second).getByRole("button", { name: "Hold it", exact: true }).click();
  await askCard(page).getByRole("button", { name: "Merge it", exact: true }).click();
  await expect.poll(async () => (await askOf(w.owner, id)).answer).toBe("Merge it");
  release();

  // Then the second browser shows "Answered · Merge it" and that its answer was not used
  await expect(second.getByText("Answered · Merge it")).toBeVisible();
  await expect(second.getByText(/was not used/)).toBeVisible();
  expect((await askOf(w.owner, id)).answer).toBe("Merge it");
});

scenario("A snoozed ask returns at its time", { tag: ["@browser"] }, async ({ server, page, context, dataDir, testApi }, info) => {
  info.setTimeout(90_000);
  // Given an open ask of "devtool"
  const w = await browserWorld({ server, page, context }, { ...WORLD, plaintext: true });
  const conv = await createConversation(w.owner, { title: "Ship search filters", participants: ["devtool", "docs"] });
  const id = await agentAsks(w.srv, w.sessions.devtool!.lease, conv);
  await openNow(page, w.srv);

  // When the owner snoozes it for "1 hour"
  const card = askCard(page);
  await card.getByRole("button", { name: "Snooze" }).click();
  await page.getByRole("menuitem", { name: "1 hour" }).click();

  // Then Now lists it under snoozed with its wake time
  await expect(askCard(page)).toHaveCount(0);
  await openFold(page, "Snoozed");
  await expect(page.locator(".foldrows").getByText(/Snoozed until/)).toBeVisible();
  const until = (await nowOf(w.owner)).snoozed.find((a) => a.id === id)?.snoozed_until;
  expect(until).toBeGreaterThan(Date.now());

  // And after the test clock moves 1 hour Now lists it as open again
  await testApi(w.srv).advanceClock(61 * 60_000);
  await expect(askCard(page)).toBeVisible();
  await expect(page.getByRole("button", { name: /^Snoozed/ })).toHaveCount(0);

  // And the owner gets a "snooze_wake" notification
  const reasons = () => {
    const db = plainDb(dataDir);
    try {
      return (db.prepare("SELECT reason FROM notifications WHERE reason = 'snooze_wake'").all() as { reason: string }[]).map((r) => r.reason);
    } finally {
      db.close();
    }
  };
  expect(reasons()).toEqual(["snooze_wake"]);
});

scenario("Snooze shows an Undo toast and Undo puts the ask back", { tag: ["@browser"] }, async ({ server, page, context }, info) => {
  info.setTimeout(90_000);
  // Given an open ask of "devtool"
  const w = await browserWorld({ server, page, context }, WORLD);
  const conv = await createConversation(w.owner, { title: "Ship search filters", participants: ["devtool", "docs"] });
  const id = await agentAsks(w.srv, w.sessions.devtool!.lease, conv);
  await openNow(page, w.srv);

  // When the owner snoozes it for "1 hour"
  await askCard(page).getByRole("button", { name: "Snooze" }).click();
  await page.getByRole("menuitem", { name: "1 hour", exact: true }).click();

  // Then a toast says "Snoozed until 1 hour" with the wake time and an Undo button for 10 seconds
  const toast = page.getByRole("status").filter({ hasText: /Snoozed until 1 hour, \d{1,2}:\d{2}\s[AP]M/ });
  await expect(toast).toBeVisible();
  await expect(toast.getByRole("button", { name: "Undo" })).toBeVisible();

  // When the owner taps Undo
  await toast.getByRole("button", { name: "Undo" }).click();

  // Then Now lists the ask as open again
  await expect(askCard(page)).toHaveCount(1);
  expect((await nowOf(w.owner)).snoozed).toEqual([]);
  expect((await askOf(w.owner, id)).state).toBe("open");
});

scenario("Unsnooze returns an ask at once", { tag: ["@browser"] }, async ({ server, page, context, dataDir, testApi }, info) => {
  info.setTimeout(90_000);
  // Given an ask snoozed until tomorrow 09:00
  const w = await browserWorld({ server, page, context }, WORLD);
  const conv = await createConversation(w.owner, { title: "Ship search filters", participants: ["devtool", "docs"] });
  const id = await agentAsks(w.srv, w.sessions.devtool!.lease, conv);
  must(await snoozeAsk(w.owner, id, { preset: "tomorrow", tz: "America/New_York" }), "snooze until tomorrow");
  await openNow(page, w.srv);
  await expect(askCard(page)).toHaveCount(0);

  // When the owner unsnoozes it
  await openFold(page, "Snoozed");
  await page.getByRole("button", { name: "Unsnooze" }).click();

  // Then Now lists it as open
  await expect(askCard(page)).toBeVisible();
  expect((await nowOf(w.owner)).asks.map((a) => a.id)).toEqual([id]);
});

scenario("Snooze presets set the right wake time", { tag: ["@browser"] }, async ({ server, page, context, dataDir, testApi }, info) => {
  info.setTimeout(150_000);
  // Given the time is 2026-10-16 14:00 in the owner's time zone
  const w = await browserWorld({ server, page, context }, WORLD);
  const conv = await createConversation(w.owner, { title: "Ship search filters", participants: ["devtool", "docs"] });
  await setServerTime(testApi(w.srv), w.owner, "2026-10-16T14:00:00-04:00");
  const rows: [preset: string, wake: string][] = [
    ["1 hour", "2026-10-16T15:00:00"],
    ["Tonight", "2026-10-16T18:00:00"],
    ["Tomorrow", "2026-10-17T09:00:00"],
  ];
  for (const [preset, wake] of rows) {
    const id = await agentAsks(w.srv, w.sessions.devtool!.lease, conv, { question: `Snooze with ${preset}?` });

    // When the owner snoozes an ask with "<preset>"
    await openNow(page, w.srv);
    const card = askCard(page, `Snooze with ${preset}?`);
    await card.getByRole("button", { name: "Snooze" }).click();
    await page.getByRole("menuitem", { name: preset, exact: true }).click();
    await expect(card).toHaveCount(0);

    // Then the wake time is <wake>
    const until = (await nowOf(w.owner)).snoozed.find((a) => a.id === id)?.snoozed_until;
    expect([preset, until && new Date(until).toISOString()]).toEqual([preset, new Date(NY(wake)).toISOString()]);
  }
});

scenario("The count updates in every open tab", { tag: ["@browser"] }, async ({ server, page, context, dataDir, testApi }, info) => {
  info.setTimeout(90_000);
  // Given Now is open in two tabs with 3 open asks
  const w = await browserWorld({ server, page, context }, WORLD);
  const conv = await createConversation(w.owner, { title: "Ship search filters", participants: ["devtool", "docs"] });
  for (const q of ["First?", "Second?", "Third?"]) await agentAsks(w.srv, w.sessions.devtool!.lease, conv, { question: q });
  const other = await context.newPage();
  await openNow(page, w.srv);
  await openNow(other, w.srv);
  await expect(page.locator("#open-count")).toHaveText("3 open");
  await expect(other.locator("#open-count")).toHaveText("3 open");

  // When the owner dismisses an ask in one tab
  await askCard(page, "Third?").getByRole("button", { name: "Dismiss" }).click();

  // Then both tabs show 2 open asks with no reload
  await expect(page.locator("#open-count")).toHaveText("2 open");
  await expect(other.locator("#open-count")).toHaveText("2 open");
  await expect(other.getByRole("article")).toHaveCount(2);
});

scenario("Tonight is not offered from 6:00 PM", { tag: ["@browser"] }, async ({ server, page, context, dataDir, testApi }, info) => {
  info.setTimeout(90_000);
  // Given the time is 2026-10-16 19:30 in the owner's time zone
  const w = await browserWorld({ server, page, context }, WORLD);
  const conv = await createConversation(w.owner, { title: "Ship search filters", participants: ["devtool", "docs"] });
  await agentAsks(w.srv, w.sessions.devtool!.lease, conv);
  await setServerTime(testApi(w.srv), w.owner, "2026-10-16T19:30:00-04:00");

  // When the owner opens the snooze menu of an open ask
  await openNow(page, w.srv);
  await askCard(page).getByRole("button", { name: "Snooze" }).click();

  // Then it offers "1 hour" and "Tomorrow" but not "Tonight"
  await expect(page.getByRole("menuitem")).toHaveText(["1 hour", "Tomorrow"]);
  await expect(page.getByRole("menuitem", { name: "Tonight" })).toHaveCount(0);
});

scenario("Approving a pending add lets the agent in from the request", { tag: ["@browser"] }, async ({ server, page, context, dataDir, testApi }, info) => {
  info.setTimeout(90_000);
  // Given "devtool" requested to add "@docs" to conversation 52 at message 300
  const w = await browserWorld({ server, page, context }, { ...WORLD, agents: ["devtool", "docs"] });
  const conv = await createConversation(w.owner, { title: "Release prep", participants: ["devtool"] });
  await ownerSays(w.owner, conv, "Earlier message one");
  await ownerSays(w.owner, conv, "Earlier message two");
  must(await asAgent(w.srv, w.sessions.devtool!.lease, "POST", `/api/conversations/${conv}/participants`, { handle: "docs" }), "request the add", 201);
  await ownerSays(w.owner, conv, "Message after the request");

  // When the owner approves the add
  await openNow(page, w.srv);
  await page.getByRole("article", { name: /wants to add/ }).getByRole("button", { name: "Approve", exact: true }).click();
  await expect(page.getByRole("article", { name: /wants to add/ })).toHaveCount(0);

  // Then conversation 52 shows "Approved · @docs added"
  await page.goto(`${w.srv.origin}/chats/${conv}`);
  await expect(page.getByText("Approved · @docs added")).toBeVisible();

  // And "docs" reads conversation 52 with the earlier messages and the ones after the request
  const read = await convoz(w.box, w.sessions.docs!.sid, ["read", String(conv)]);
  expect(read.code).toBe(0);
  expect(read.stdout).toContain("Message after the request");
  expect(read.stdout).toContain("Earlier message one");
});

scenario("Declining a pending add keeps the agent out", { tag: ["@browser"] }, async ({ server, page, context, dataDir, testApi }, info) => {
  info.setTimeout(90_000);
  // Given "devtool" requested to add "@docs" to conversation 52
  const w = await browserWorld({ server, page, context }, { ...WORLD, agents: ["devtool", "docs"] });
  const conv = await createConversation(w.owner, { title: "Release prep", participants: ["devtool"] });
  must(await asAgent(w.srv, w.sessions.devtool!.lease, "POST", `/api/conversations/${conv}/participants`, { handle: "docs" }), "request the add", 201);

  // When the owner declines the add
  await openNow(page, w.srv);
  await page.getByRole("article", { name: /wants to add/ }).getByRole("button", { name: "Decline", exact: true }).click();
  await expect(page.getByRole("article", { name: /wants to add/ })).toHaveCount(0);

  // Then conversation 52 shows "Declined"
  await page.goto(`${w.srv.origin}/chats/${conv}`);
  await expect(page.getByText(/Declined/)).toBeVisible();

  // And "docs" cannot read conversation 52
  const res = await asAgent(w.srv, w.sessions.docs!.lease, "GET", `/api/conversations/${conv}/messages`);
  expect(res.status).toBe(403);
});

scenario("A machine request deep link brings its card into view", { tag: ["@browser"] }, async ({ server, page, context, dataDir, testApi }, info) => {
  info.setTimeout(90_000);
  // Given a machine request "box-9" with request id 9 is pending
  const w = await browserWorld({ server, page, context }, WORLD);
  await seedUserCodes(w.srv, ["PLRT-HXCV"]);
  const req = await requestMachine(w.srv, w.owner, "box-9");

  // When the owner opens "/now/machine/9"
  await page.goto(`${w.srv.origin}/now/machine/${req.requestId}`);

  // Then the card of "box-9" is in view with its code, the reported host info and the source, and Approve and Decline
  const card = nowCard(page, "box-9");
  await expect(card).toBeInViewport();
  await expect(card).toContainText("PLRT-HXCV");
  await expect(card).toContainText("box-9.TESTONLY.local");
  await expect(card).toContainText(/Source: /);
  await expect(card.getByRole("button", { name: "Approve", exact: true })).toBeVisible();
  await expect(card.getByRole("button", { name: "Decline", exact: true })).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

scenario("Now shows an agent's connect request as one card with Approve and Decline", { tag: ["@browser"] }, async ({ server, page, context }, info) => {
  info.setTimeout(90_000);
  // Given an agent asked to connect as "dev-ci" from the machine "box-2" with the description "Runs CI"
  const w = await browserWorld({ server, page, context }, WORLD);
  must(await mintSession(w.srv, w.box2.key, { as: "dev-ci", create: { description: "Runs CI" } }), "identity request", 202);

  // When the owner opens Now
  await openNow(page, w.srv);

  // Then one card reads "box-2 wants to connect as @dev-ci" with "Runs CI" under "From the agent"
  const card = page.getByRole("article", { name: "box-2 wants to connect as @dev-ci", exact: true });
  await expect(card).toBeVisible();
  await expect(card).toContainText("From the agent");
  await expect(card).toContainText("Runs CI");

  // And the card has Approve and Decline
  await expect(card.getByRole("button", { name: "Approve", exact: true })).toBeVisible();
  await expect(card.getByRole("button", { name: "Decline", exact: true })).toBeVisible();

  // And Deny all removes it
  await page.getByRole("button", { name: "Deny all", exact: true }).click();
  await expect(page.getByRole("article")).toHaveCount(0);
});

scenario("An expired machine request leaves Now", { tag: ["@browser"] }, async ({ server, page, context, dataDir, testApi }, info) => {
  info.setTimeout(90_000);
  // Given a machine request "box-9" made 10 minutes ago
  const w = await browserWorld({ server, page, context }, WORLD);
  await requestMachine(w.srv, w.owner, "box-9");
  await openNow(page, w.srv);
  await expect(nowCard(page, "box-9")).toBeVisible();

  // When the test clock passes its expiry
  await testApi(w.srv).advanceClock(10 * 60_000 + 1_000);

  // Then Now no longer shows it with no reload
  await expect(nowCard(page, "box-9")).toHaveCount(0);
  await expect(page.getByText("All clear. Nothing needs you.")).toBeVisible();
});

// ---- contracts/now.feature --------------------------------------------------------------------------------------

scenario("A human cannot be the target of a pending add", { tag: ["@api"] }, async ({ server }) => {
  // Given "devtool" and "docs" are active participants of conversation 41 "Ship search filters"
  const { w, devtool } = await askWorld(server);
  const conv52 = await createConversation(w.owner, { title: "Release prep", participants: ["devtool"] });
  const ids = await idsOf(w.owner);

  // When "devtool" requests to add the owner to conversation 52
  const res = await asAgent(w.srv, devtool.lease, "POST", `/api/conversations/${conv52}/participants`, { identity_id: ids.drew });

  // Then the server answers 400
  expect(res.status).toBe(400);
  expect((await nowOf(w.owner)).pending_adds).toEqual([]);
});
