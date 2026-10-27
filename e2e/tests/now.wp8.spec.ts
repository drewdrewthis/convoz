import { agentPost, agentSays, convoz, createConversation, listConversations, ownerReads, ownerSays, unreadOf } from "../lib/chat.ts";
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
import { openRail, rail, setPrefs } from "../lib/rail-wp9.ts";
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
    // And this browser last had Now in the desktop rail (rail.feature, "On a wide screen Now is a view of the rail")
    try {
      localStorage.setItem("convoz.rail.mode", "now");
    } catch {
      // an opaque origin (about:blank) has no storage; the app's own pages do
    }
  });
  const w = await browserWorld({ server, page, context }, WORLD);
  const conv = await createConversation(w.owner, { title: "Ship search filters", participants: ["devtool", "docs"] });
  const ids = [];
  for (const q of ["First?", "Second?", "Third?"]) ids.push(await agentAsks(w.srv, w.sessions.devtool!.lease, conv, { question: q }));
  must(await snoozeAsk(w.owner, ids[0]!, { preset: "1h" }), "snooze one");
  expect((await nowOf(w.owner)).badge).toBe(2);

  // When the owner opens Now on the phone
  await openNow(page, w.srv);
  await expect(page.getByRole("article")).toHaveCount(2);

  // Then Now is the full-screen page with no rail and no Now toggle button
  await expect(page.getByRole("navigation", { name: "Conversations" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Now\b/ })).toHaveCount(0);
  await expect(page.getByRole("navigation", { name: "Main" })).toBeVisible();
  expect((await page.locator("#view").boundingBox())!.x).toBeLessThan(40);

  // When the installed app is in the background
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
  await expect(page.getByRole("list", { name: "Other chats" })).toBeInViewport();

  // And the "Other chats" list has one row for conversation 41 reading "devtool, 5 new"
  const rows = page.getByRole("list", { name: "Other chats" }).getByRole("listitem");
  await expect(rows).toHaveCount(1);
  await expect(rows.getByRole("link")).toContainText("Ship search filters");
  await expect(rows.getByRole("link")).toContainText("devtool, 5 new");
});

scenario("Now puts an ask and an @mention of the owner under Needs you", { tag: ["@browser"] }, async ({ server, page, context }, info) => {
  info.setTimeout(90_000);
  // Given an open ask of "devtool" in conversation 41 and "docs" posted "@drew can you check the deploy log?" in conversation 42, and "devtool" posted "Build 812 is green" in conversation 43
  const w = await browserWorld({ server, page, context }, WORLD);
  const c41 = await createConversation(w.owner, { title: "Ship search filters", participants: ["devtool", "docs"] });
  const c42 = await createConversation(w.owner, { title: "Deploy log", participants: ["devtool", "docs"] });
  const c43 = await createConversation(w.owner, { title: "Nightly builds", participants: ["devtool", "docs"] });
  await agentAsks(w.srv, w.sessions.devtool!.lease, c41, {});
  await agentSays(w.srv, w.sessions.docs!.lease, c42, "@drew can you check the deploy log?");
  await agentSays(w.srv, w.sessions.devtool!.lease, c43, "Build 812 is green");

  // When the owner opens Now
  await openNow(page, w.srv);

  // Then the heading "Needs you · 2" is shown above the ask
  const heading = page.getByText("Needs you · 2", { exact: true });
  await expect(heading).toBeVisible();
  expect((await heading.boundingBox())!.y).toBeLessThan((await askCard(page).boundingBox())!.y);

  // And the "Mentions of you" list has one card for conversation 42 with the line "docs @drew can you check the deploy log?"
  const mentions = page.getByRole("list", { name: "Mentions of you" }).getByRole("listitem");
  await expect(mentions).toHaveCount(1);
  await expect(mentions.getByRole("heading")).toHaveText("Deploy log");
  await expect(mentions.locator(".uline")).toHaveText("docs @drew can you check the deploy log?");

  // And conversation 43 is only under "Other chats"
  await expect(page.getByRole("list", { name: "Other chats" }).getByRole("link", { name: /Nightly builds/ })).toHaveAttribute("href", `/chats/${c43}`);
  await expect(mentions.filter({ hasText: "Nightly builds" })).toHaveCount(0);
  await expect(page.getByRole("list", { name: "Replies to you" }).filter({ hasText: "Nightly builds" })).toHaveCount(0);
});

// Owner, conv 179 msg 6018 (UX review): the Needs you count and the Now badge must be one number
scenario("The Needs you count and the rail badge are the same number", { tag: ["@browser"] }, async ({ server, page, context }, info) => {
  info.setTimeout(90_000);
  // Given an open ask of "devtool" in conversation 41 and "docs" posted "@drew can you check the deploy log?" in conversation 42
  const w = await browserWorld({ server, page, context }, WORLD);
  const c41 = await createConversation(w.owner, { title: "Ship search filters", participants: ["devtool", "docs"] });
  const c42 = await createConversation(w.owner, { title: "Deploy log", participants: ["devtool", "docs"] });
  await agentAsks(w.srv, w.sessions.devtool!.lease, c41, {});
  await agentSays(w.srv, w.sessions.docs!.lease, c42, "@drew can you check the deploy log?");

  // When the owner opens Now on a wide screen
  await openRail(page, w.srv, "/");
  await page.getByRole("heading", { name: "Now", exact: true }).waitFor();

  // Then the heading "Needs you · 2" is shown
  await expect(page.getByText("Needs you · 2", { exact: true })).toBeVisible();

  // And the Now item in the rail shows 2
  await expect(rail(page).locator(".rbadge")).toHaveText("2");
});

/** Open conversation `conv` on a wide screen and turn the rail to Now. */
async function railNow(page: Page, w: Awaited<ReturnType<typeof browserWorld>>, conv: number): Promise<void> {
  await openRail(page, w.srv, `/chats/${conv}`);
  const now = rail(page).getByRole("button", { name: /^Now\b/ });
  await now.click();
  await expect(now).toHaveAttribute("aria-pressed", "true");
}

// Owner, conv 179 msg 6018 (UX review): in the sidebar, Other chats is one line until the owner opens it
scenario("The sidebar folds Other chats to one line", { tag: ["@browser"] }, async ({ server, page, context }, info) => {
  info.setTimeout(120_000);
  // Given "devtool" posted 1 message in each of 12 conversations the owner has not read, and conversation 41 has nothing new
  const w = await browserWorld({ server, page, context }, WORLD);
  const home = await createConversation(w.owner, { title: "Ship search filters", participants: ["devtool", "docs"] });
  const chats: number[] = [];
  for (let n = 1; n <= 12; n++) {
    const conv = await createConversation(w.owner, { title: `Chatter ${n}`, participants: ["devtool", "docs"] });
    await agentSays(w.srv, w.sessions.devtool!.lease, conv, `News ${n}`);
    chats.push(conv);
  }

  // When the owner opens conversation 41 on a wide screen and turns the rail to Now
  await railNow(page, w, home);

  // Then the rail shows one row "12 other chats, 12 new" with "Mark all read", and no list of chats
  const row = rail(page).getByRole("button", { name: "12 other chats, 12 new", exact: true });
  await expect(row).toBeVisible();
  await expect(row).toHaveAttribute("aria-expanded", "false");
  const markAll = rail(page).getByRole("button", { name: "Mark all read", exact: true });
  await expect(markAll).toBeVisible();
  const list = rail(page).getByRole("list", { name: "Other chats" });
  await expect(list).toHaveCount(0);

  // When the owner taps "12 other chats, 12 new"
  await row.click();

  // Then the rail lists the 10 newest of the 12 chats and a "Show all" button
  await expect(row).toHaveAttribute("aria-expanded", "true");
  await expect(list.getByRole("listitem")).toHaveCount(10);
  await expect(list.getByRole("listitem").first()).toContainText("Chatter 12");
  await expect(list.getByRole("listitem").last()).toContainText("Chatter 3");
  const showAll = rail(page).getByRole("button", { name: "Show all", exact: true });
  await expect(showAll).toBeVisible();

  // When the owner taps "Show all"
  await showAll.click();

  // Then the rail lists all 12 chats
  await expect(list.getByRole("listitem")).toHaveCount(12);
  await expect(showAll).toHaveCount(0);

  // When the owner taps "Mark all read"
  await markAll.click();

  // Then the row is gone and the 12 conversations have 0 unread
  await expect(rail(page).getByRole("button", { name: /other chats/ })).toHaveCount(0);
  await expect(list).toHaveCount(0);
  for (const conv of chats) expect(await unreadOf(w.owner, conv)).toBe(0);
});

// Owner, conv 179 msg 6018 (UX review): a sidebar ask card is short: the question, the recommended answer and Open
scenario("A sidebar ask card shows the title, the first answer and Open", { tag: ["@browser"] }, async ({ server, page, context }, info) => {
  info.setTimeout(90_000);
  // Given "devtool" asked "Merge #415 on its own?" with "Merge it" recommended and "Hold it" the alternative in conversation 52
  const w = await browserWorld({ server, page, context }, WORLD);
  const home = await createConversation(w.owner, { title: "Ship search filters", participants: ["devtool", "docs"] });
  const c52 = await createConversation(w.owner, { title: "Release train", participants: ["devtool", "docs"] });
  const id = await agentAsks(w.srv, w.sessions.devtool!.lease, c52, {});

  // When the owner opens conversation 41 on a wide screen and turns the rail to Now
  await railNow(page, w, home);

  // Then the ask card in the rail shows the question, a "Merge it" button and an "Open conversation" link to conversation 52
  const card = rail(page).getByRole("article", { name: QUESTION });
  await expect(card).toBeVisible();
  await expect(card.getByRole("heading", { name: QUESTION })).toBeVisible();
  await expect(card.getByRole("button", { name: "Merge it", exact: true })).toBeVisible();
  await expect(card.getByRole("link", { name: "Open conversation", exact: true })).toHaveAttribute("href", `/chats/${c52}`);

  // And it offers Dismiss, and shows no "Hold it", "Quick reply", "Snooze" or "I have questions"
  await expect(card.getByRole("button", { name: "Dismiss", exact: true })).toBeVisible();
  for (const name of ["Hold it", "Quick reply", "Snooze", "I have questions"]) await expect(card.getByRole("button", { name, exact: true }), name).toHaveCount(0);

  // When the owner taps "Merge it"
  await card.getByRole("button", { name: "Merge it", exact: true }).click();

  // Then the ask is answered with "Merge it" and leaves the rail
  await expect(card).toHaveCount(0);
  const ask = await askOf(w.owner, id);
  expect({ state: ask.state, chosen: ask.chosen?.kind }).toEqual({ state: "answered", chosen: "recommended" });
});

// Owner, conv 179 msg 6018 (UX review): a card that needs the owner is cleared with Done; a reply card keeps Mark read
scenario("A Needs you card has Done instead of Mark read", { tag: ["@browser"] }, async ({ server, page, context }, info) => {
  info.setTimeout(90_000);
  // Given "docs" posted "@drew can you check the deploy log?" in conversation 42, and the owner wrote "What broke in the nightly?" in conversation 41 and "devtool" answered
  const w = await browserWorld({ server, page, context }, WORLD);
  const c41 = await createConversation(w.owner, { title: "Ship search filters", participants: ["devtool", "docs"] });
  const c42 = await createConversation(w.owner, { title: "Deploy log", participants: ["devtool", "docs"] });
  await agentSays(w.srv, w.sessions.docs!.lease, c42, "@drew can you check the deploy log?");
  await ownerSays(w.owner, c41, "What broke in the nightly?");
  await agentSays(w.srv, w.sessions.devtool!.lease, c41, "The lint step timed out");

  // When the owner opens Now
  await openNow(page, w.srv);

  // Then the card of conversation 42 under Needs you has "Done" and no "Mark read"
  const mention = page.getByRole("list", { name: "Mentions of you" }).getByRole("listitem").filter({ hasText: "Deploy log" });
  await expect(mention).toHaveCount(1);
  await expect(mention.getByRole("button", { name: "Done with Deploy log", exact: true })).toBeVisible();
  await expect(mention.getByRole("button", { name: /^Mark .* read$/ })).toHaveCount(0);

  // And the card of conversation 41 under "Replies to you" has "Mark read" and no "Done"
  const reply = page.getByRole("list", { name: "Replies to you" }).getByRole("listitem").filter({ hasText: "Ship search filters" });
  await expect(reply.getByRole("button", { name: "Mark Ship search filters read", exact: true })).toBeVisible();
  await expect(reply.getByRole("button", { name: /^Done with/ })).toHaveCount(0);

  // When the owner taps "Done" on the card of conversation 42
  await mention.getByRole("button", { name: "Done with Deploy log", exact: true }).click();

  // Then the card leaves the list and conversation 42 has 0 unread
  await expect(mention).toHaveCount(0);
  await expect.poll(() => unreadOf(w.owner, c42)).toBe(0);
});

scenario("Marking two cards read in a row works and the other cards stay clickable", { tag: ["@browser"] }, async ({ server, page, context }, info) => {
  info.setTimeout(90_000);
  // Given 3 conversations where an agent @mentions the owner, so "Mentions of you" has 3 cards, and the first "Done" is slow to finish
  const w = await browserWorld({ server, page, context }, WORLD);
  const titles = ["Deploy log", "Nightly builds", "Search filters"];
  for (const title of titles) {
    const conv = await createConversation(w.owner, { title, participants: ["devtool", "docs"] });
    await agentSays(w.srv, w.sessions.docs!.lease, conv, `@drew look at ${title}`);
  }
  const [a, b, c] = titles;
  let releaseFirst!: () => void;
  const firstHeld = new Promise<void>((resolve) => (releaseFirst = resolve));
  let reads = 0;
  await page.route("**/api/conversations/*/read", async (route) => {
    if (reads++ === 0) await firstHeld;
    await route.continue();
  });

  // When the owner opens Now and taps "Done" on the first card
  await openNow(page, w.srv);
  const cards = page.getByRole("list", { name: "Mentions of you" }).getByRole("listitem");
  await expect(cards).toHaveCount(3);
  await page.getByRole("button", { name: `Done with ${a}` }).click();

  // Then "Done" on the other two cards is still enabled
  await expect(page.getByRole("button", { name: `Done with ${b}` })).toBeEnabled();
  await expect(page.getByRole("button", { name: `Done with ${c}` })).toBeEnabled();

  // When the owner taps "Done" on the second card
  await page.getByRole("button", { name: `Done with ${b}` }).click();

  // Then the second card leaves the list
  await expect(cards.filter({ hasText: b })).toHaveCount(0);

  // When the first "Done" finishes
  releaseFirst();

  // Then the first card leaves the list
  await expect(cards.filter({ hasText: a })).toHaveCount(0);

  // And only the third card is left, and its "Done" button is enabled
  await expect(cards).toHaveCount(1);
  await expect(page.getByRole("button", { name: `Done with ${c}` })).toBeEnabled();
});

// Issue 103: a mention card has "Later"; the card hides until the time, and a new @mention brings it back at once
scenario("Later hides a mention card until its time comes", { tag: ["@browser"] }, async ({ server, page, context, testApi }, info) => {
  info.setTimeout(90_000);
  // Given "docs" posted "@drew can you check the deploy log?" in conversation 42
  const w = await browserWorld({ server, page, context }, WORLD);
  const c42 = await createConversation(w.owner, { title: "Deploy log", participants: ["devtool", "docs"] });
  await agentSays(w.srv, w.sessions.docs!.lease, c42, "@drew can you check the deploy log?");

  // When the owner opens Now and taps "Later" on the card of conversation 42 and picks "1 hour"
  await openNow(page, w.srv);
  const cards = page.getByRole("list", { name: "Mentions of you" }).getByRole("listitem");
  await cards.filter({ hasText: "Deploy log" }).getByRole("button", { name: "Later", exact: true }).click();
  await page.getByRole("menuitem", { name: "1 hour", exact: true }).click();

  // Then the card leaves "Mentions of you" and the heading "Needs you" is gone
  await expect(cards.filter({ hasText: "Deploy log" })).toHaveCount(0);
  await expect(page.getByText(/^Needs you/)).toHaveCount(0);

  // When the test clock moves 61 minutes on and the owner reloads Now
  await testApi(w.srv).advanceClock(61 * 60_000);
  await page.reload();

  // Then the card of conversation 42 is back under Needs you
  await expect(cards.filter({ hasText: "Deploy log" })).toHaveCount(1);
});

scenario("A new @mention after Later brings the card back at once", { tag: ["@browser"] }, async ({ server, page, context }, info) => {
  info.setTimeout(90_000);
  // Given "docs" posted "@drew can you check the deploy log?" in conversation 42, and the owner picked "Later" for 1 hour on its card
  const w = await browserWorld({ server, page, context }, WORLD);
  const c42 = await createConversation(w.owner, { title: "Deploy log", participants: ["devtool", "docs"] });
  await agentSays(w.srv, w.sessions.docs!.lease, c42, "@drew can you check the deploy log?");
  await openNow(page, w.srv);
  const cards = page.getByRole("list", { name: "Mentions of you" }).getByRole("listitem");
  await cards.filter({ hasText: "Deploy log" }).getByRole("button", { name: "Later", exact: true }).click();
  await page.getByRole("menuitem", { name: "1 hour", exact: true }).click();
  await expect(cards.filter({ hasText: "Deploy log" })).toHaveCount(0);

  // When "docs" posts "@drew still there?" in conversation 42
  await agentSays(w.srv, w.sessions.docs!.lease, c42, "@drew still there?");

  // Then the card of conversation 42 is back under Needs you with the line "docs @drew still there?"
  const back = cards.filter({ hasText: "Deploy log" });
  await expect(back).toHaveCount(1);
  await expect(back.locator(".uline")).toHaveText(/docs\s+@drew still there\?/);
});

scenario("A reply to the owner's message shows the full latest message under Replies to you", { tag: ["@browser"] }, async ({ server, page, context }, info) => {
  info.setTimeout(90_000);
  // Given the owner wrote "What broke in the nightly?" in conversation 41 and "devtool" answered with a 300-character message
  const w = await browserWorld({ server, page, context }, WORLD);
  const conv = await createConversation(w.owner, { title: "Ship search filters", participants: ["devtool", "docs"] });
  await ownerSays(w.owner, conv, "What broke in the nightly?");
  const answer = `The nightly broke at the lint step. ${"The cache key changed after the lockfile bump, so every shard rebuilt cold and timed out. ".repeat(3)}`.slice(0, 300).trimEnd();
  expect(answer.length).toBeGreaterThan(250);
  await agentSays(w.srv, w.sessions.devtool!.lease, conv, answer);

  // When the owner opens Now
  await openNow(page, w.srv);

  // Then "Replies to you" has one card for conversation 41 showing the whole answer
  const cards = page.getByRole("list", { name: "Replies to you" }).getByRole("listitem");
  await expect(cards).toHaveCount(1);
  await expect(cards.getByRole("heading")).toHaveText("Ship search filters");
  await expect(cards.getByText(answer, { exact: false })).toBeVisible();
  await expect(cards.locator(".uline")).toContainText(answer);

  // And no "Needs you" heading is shown
  await expect(page.getByText(/^Needs you/)).toHaveCount(0);
});

scenario("Agent talk the owner is not in folds to one line per chat with one Mark all read", { tag: ["@browser"] }, async ({ server, page, context }, info) => {
  info.setTimeout(90_000);
  // Given "devtool" posted 2 messages in conversation 41 and "docs" posted 1 message in conversation 42, and the owner wrote nothing
  const w = await browserWorld({ server, page, context }, WORLD);
  const c41 = await createConversation(w.owner, { title: "Ship search filters", participants: ["devtool", "docs"] });
  const c42 = await createConversation(w.owner, { title: "Deploy log", participants: ["devtool", "docs"] });
  await agentSays(w.srv, w.sessions.devtool!.lease, c41, "News 1");
  await agentSays(w.srv, w.sessions.devtool!.lease, c41, "News 2");
  await agentSays(w.srv, w.sessions.docs!.lease, c42, "Docs news");

  // When the owner opens Now
  await openNow(page, w.srv);

  // Then "Other chats" has 2 rows, one reading "devtool, 2 new" and one "docs, 1 new", with no message lines
  const list = page.getByRole("list", { name: "Other chats" });
  await expect(list.getByRole("listitem")).toHaveCount(2);
  await expect(list.getByRole("link", { name: /Ship search filters/ })).toContainText("devtool, 2 new");
  await expect(list.getByRole("link", { name: /Deploy log/ })).toContainText("docs, 1 new");
  await expect(list.locator(".uline")).toHaveCount(0);

  // When the owner taps "Mark all read"
  await page.getByRole("button", { name: "Mark all read" }).click();

  // Then both conversations have 0 unread and Now says "All clear. Nothing needs you."
  await expect(page.getByText("All clear. Nothing needs you.")).toBeVisible();
  expect(await unreadOf(w.owner, c41)).toBe(0);
  expect(await unreadOf(w.owner, c42)).toBe(0);
});

scenario("A chat whose only new message is an ask is listed under Other chats", { tag: ["@browser"] }, async ({ server, page, context }, info) => {
  info.setTimeout(90_000);
  // Given "devtool" asked the owner a question in conversation 41, and nothing else is new there
  const w = await browserWorld({ server, page, context }, WORLD);
  const c = await createConversation(w.owner, { title: "Ship search filters", participants: ["devtool", "docs"] });
  await agentAsks(w.srv, w.sessions.devtool!.lease, c, {});

  // When the owner opens Now
  await openNow(page, w.srv);

  // Then "Other chats" has one row for conversation 41 reading "devtool, 1 new"
  const list = page.getByRole("list", { name: "Other chats" });
  await expect(list.getByRole("listitem")).toHaveCount(1);
  await expect(list.getByRole("link")).toHaveAttribute("href", `/chats/${c}`);
  await expect(list.getByRole("link")).toContainText("devtool, 1 new");

  // When the owner taps "Mark all read"
  await page.getByRole("button", { name: "Mark all read" }).click();

  // Then the "Other chats" list is gone
  await expect(list).toHaveCount(0);
});

scenario("Marking all read from Now clears the list and shows all clear", { tag: ["@browser"] }, async ({ server, page, context }, info) => {
  info.setTimeout(90_000);
  // Given no decision waits and "devtool" posted 2 messages in conversation 41 that the owner has not read
  const { w, conv } = await unreadWorld({ server, page, context }, ["First news", "Latest news"]);

  // When the owner opens Now and taps "Mark all read"
  await openNow(page, w.srv);
  await page.getByRole("button", { name: "Mark all read" }).click();

  // Then the "Other chats" list is gone and Now says "All clear. Nothing needs you."
  await expect(page.getByRole("list", { name: "Other chats" })).toHaveCount(0);
  await expect(page.getByText("All clear. Nothing needs you.")).toBeVisible();
  expect(await unreadOf(w.owner, conv)).toBe(0);
});

scenario("A muted conversation is not listed under Unread", { tag: ["@browser"] }, async ({ server, page, context }, info) => {
  info.setTimeout(90_000);
  // Given no decision waits and "devtool" posted 2 messages in a muted conversation 41 that the owner has not read
  const { w } = await unreadWorld({ server, page, context }, ["First news", "Latest news"], true);

  // When the owner opens Now
  await openNow(page, w.srv);

  // Then Now says "All clear. Nothing needs you." and has no "Other chats" list
  await expect(page.getByText("All clear. Nothing needs you.")).toBeVisible();
  await expect(page.getByRole("list", { name: "Other chats" })).toHaveCount(0);
});

scenario("Opening an unread row lands at the first unread message", { tag: ["@browser"] }, async ({ server, page, context }, info) => {
  info.setTimeout(90_000);
  // Given no decision waits and "devtool" posted "First news", "Second news" and "Third news" in conversation 41 that the owner has not read
  const { w, conv } = await unreadWorld({ server, page, context }, ["First news", "Second news", "Third news"]);

  // When the owner opens Now and taps the conversation 41 row under "Other chats"
  await openNow(page, w.srv);
  await page.getByRole("list", { name: "Other chats" }).getByRole("link", { name: /Ship search filters/ }).click();
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

  // | in conversation 41 | with its reply box open | (the thread is under the ask, which stays in the main list: issue 61)
  await askCard(page).getByRole("button", { name: "I have questions", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Reply in thread" })).toBeVisible();
  await expectBar(page, askCard(page), true);

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
  await expect(page.getByRole("menuitem").filter({ hasNotText: "Cancel" })).toHaveText(["1 hour", "Tomorrow"]);
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

// Owner, conv 179 msg 6018 (UX review): the server counts mentions, the client does not scan.

/** The list row of one conversation as the owner sees it. */
async function rowOf(owner: Parameters<typeof listConversations>[0], conv: number) {
  const row = (await listConversations(owner)).find((c) => c.id === conv);
  expect(row, `conversation ${conv} is listed`).toBeTruthy();
  return row!;
}

scenario("The conversation list counts the unread messages that @mention the caller", { tag: ["@api"] }, async ({ server }) => {
  const { w, conv, devtool, docs } = await askWorld(server);

  // Given the owner wrote "Status?" in conversation 41
  const root = await ownerSays(w.owner, conv, "Status?");

  // And "devtool" posted "@drew look" and then "Build 812 is green" in conversation 41
  await agentSays(w.srv, devtool.lease, conv, "@drew look");
  const last = await agentSays(w.srv, devtool.lease, conv, "Build 812 is green");

  // Then the conversation list row of conversation 41 has unread_mentions 1
  expect((await rowOf(w.owner, conv)).unread_mentions).toBe(1);

  // When the owner marks conversation 41 read
  await ownerReads(w.owner, conv, last);

  // Then the conversation list row of conversation 41 has unread_mentions 0
  expect((await rowOf(w.owner, conv)).unread_mentions).toBe(0);

  // When "docs" replies "@drew see the log" in the thread of "Status?"
  const res = await agentPost(w.srv, docs.lease, conv, "@drew see the log", { thread_root_id: root });
  expect(res.status).toBe(201);

  // Then the conversation list row of conversation 41 has unread_mentions 1
  expect((await rowOf(w.owner, conv)).unread_mentions).toBe(1);
});

scenario("The conversation list says when agents replied to the owner", { tag: ["@api"] }, async ({ server }) => {
  const { w, conv, devtool, docs } = await askWorld(server);
  const c42 = await createConversation(w.owner, { title: "Deploy log", participants: ["devtool", "docs"] });

  // Given the owner wrote "What broke in the nightly?" in conversation 41 and "devtool" answered "The lint step"
  await ownerSays(w.owner, conv, "What broke in the nightly?");
  await agentSays(w.srv, devtool.lease, conv, "The lint step");

  // And in conversation 42 only "devtool" and "docs" posted
  await agentSays(w.srv, devtool.lease, c42, "Deploy 3 is out");
  await agentSays(w.srv, docs.lease, c42, "Docs are updated");

  // Then the conversation list row of conversation 41 has replies_to_you true
  expect((await rowOf(w.owner, conv)).replies_to_you).toBe(true);

  // And the conversation list row of conversation 42 has no replies_to_you
  expect((await rowOf(w.owner, c42)).replies_to_you ?? false).toBe(false);
});

scenario("Now counts conversations with an unread mention in its badge", { tag: ["@api"] }, async ({ server }) => {
  const { w, conv, devtool, docs } = await askWorld(server);
  const c42 = await createConversation(w.owner, { title: "Deploy log", participants: ["devtool", "docs"] });
  const c43 = await createConversation(w.owner, { title: "Nightly builds", participants: ["devtool", "docs"] });

  // Given "devtool" has an open ask in conversation 41
  await agentAsks(w.srv, devtool.lease, conv);

  // And "docs" posted "@drew look" in conversation 42
  await agentSays(w.srv, docs.lease, c42, "@drew look");

  // And "docs" posted "@drew muted look" in conversation 43, which the owner muted
  await setPrefs(w.owner, c43, { muted_until: 253402300799000 });
  await agentSays(w.srv, docs.lease, c43, "@drew muted look");

  // When the owner reads GET /api/now
  const now = await nowOf(w.owner);

  // Then mentions is 1 and badge is 2
  expect(now.asks).toHaveLength(1);
  expect(now.mentions).toBe(1);
  expect(now.badge).toBe(2);
});
