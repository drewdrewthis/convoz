import type { Page } from "@playwright/test";
import { chatRow, isBold } from "../lib/chat-ui.ts";
import { ownerSays } from "../lib/chat.ts";
import { agentSays, apiRailWorld, between, desktopWindow, dragTo, openRail, patchPrefs, railGroup, railRow, railRows, railTitles, railWorld, rail, sectionOrder, setPrefs, signInWith, TITLES } from "../lib/rail-wp9.ts";
import { expect, scenario } from "../lib/scenario.ts";
import { seedDb } from "../lib/wp3.ts";

/*
 * rail.feature (and its contract in specs/contracts/rail.feature): the owner's rail. The page contract is the comment block of
 * lib/rail-wp9.ts. 41, 52 and 60 are "Ship search filters", "Deploy alerts runbook" and "Weekly usage", created in that order.
 * The rail is the desktop sidebar, so each binding that looks at it widens the window first (desktopWindow): the "mobile" project runs
 * the same steps. Rows of the phone Conversations list (/chats) keep the owner's order too (prototype v41); new activity never reorders either.
 */

const DAY = 86_400_000;
const [T41, T52, T60] = TITLES;

/** Move a conversation's last activity into the past, so "its last activity was N days ago" without moving the server clock past every lease. */
function ageOf(dataDir: string, conv: number, days: number): void {
  seedDb(dataDir, (db) => db.prepare("UPDATE conversations SET last_activity_at = last_activity_at - ? WHERE id = ?").run(days * DAY, conv));
}

const titlesOf = async (page: Page) => railTitles(page, "Conversations");

scenario("A new conversation goes to the top", { tag: ["@browser"] }, async ({ server, page, context }) => {
  // Background: conversations 41, 52 and 60 were created in that order with "devtool"
  const u = await railWorld({ server, page, context });

  // Then the Conversations group lists 60, 52, 41 in that order
  await openRail(page, u.w.srv);
  await expect(railGroup(page, "Conversations").locator(".rtitle")).toHaveText([T60, T52, T41]);
});

scenario("Activity never reorders the rail", { tag: ["@browser"] }, async ({ server, page, context }) => {
  const u = await railWorld({ server, page, context });
  await openRail(page, u.w.srv);
  await expect(railGroup(page, "Conversations").locator(".rtitle")).toHaveText([T60, T52, T41]);

  // When "devtool" posts in conversation 41
  await agentSays(u.w, "devtool", u.c[41], "Tests are green");

  // Then conversation 41 is bold with its new preview (the Conversations list in the page shows the preview line)
  await expect(chatRow(page, T41).getByText("devtool: Tests are green")).toBeVisible({ timeout: 5_000 });
  expect(await isBold(chatRow(page, T41).getByRole("heading"))).toBe(true);
  await expect(railRow(page, T41).getByRole("link")).toHaveClass(/unread/);

  // And the Conversations group still lists 60, 52, 41
  await expect(railGroup(page, "Conversations").locator(".rtitle")).toHaveText([T60, T52, T41]);
  expect((await railRows(u.w.owner)).find((c) => c.id === u.c[41])!.rank).toBeLessThan((await railRows(u.w.owner)).find((c) => c.id === u.c[52])!.rank);
});

scenario("Dragging a conversation puts it between its neighbours", { tag: ["@browser"] }, async ({ server, page, context, browser }) => {
  const u = await railWorld({ server, page, context });
  await openRail(page, u.w.srv);
  await expect(railGroup(page, "Conversations").locator(".rtitle")).toHaveText([T60, T52, T41]);

  // A second browser of the owner has the rail open already
  const other = await browser.newContext();
  try {
    const page2 = await other.newPage();
    await signInWith(u.w.srv, u.second, page2, other);
    await openRail(page2, u.w.srv);
    await expect(railGroup(page2, "Conversations").locator(".rtitle")).toHaveText([T60, T52, T41]);

    // When the owner drags conversation 41 between 60 and 52
    await dragTo(page, railRow(page, T41), await between(railRow(page, T60), railRow(page, T52)));

    // Then the Conversations group lists 60, 41, 52
    await expect(railGroup(page, "Conversations").locator(".rtitle")).toHaveText([T60, T41, T52]);

    // And a second browser shows the same order after a reload
    await page2.reload();
    await expect(railGroup(page2, "Conversations").locator(".rtitle")).toHaveText([T60, T41, T52]);
  } finally {
    await other.close();
  }
});

scenario("The keyboard can reorder the rail", { tag: ["@browser"] }, async ({ server, page, context }) => {
  const u = await railWorld({ server, page, context });
  await openRail(page, u.w.srv);
  await expect(railGroup(page, "Conversations").locator(".rtitle")).toHaveText([T60, T52, T41]);

  // Given conversation 41 has focus in reorder mode
  const grip = page.getByRole("button", { name: `Reorder ${T41}. Alt plus arrow keys move it.` });
  await grip.focus();
  await expect(grip).toBeFocused();

  // When the owner presses Alt+ArrowUp twice
  await page.keyboard.press("Alt+ArrowUp");
  await expect(railGroup(page, "Conversations").locator(".rtitle")).toHaveText([T60, T41, T52]);
  await page.keyboard.press("Alt+ArrowUp");

  // Then conversation 41 is first in the Conversations group
  await expect(railGroup(page, "Conversations").locator(".rtitle")).toHaveText([T41, T60, T52]);
  await expect(grip).toBeFocused();
  expect(await sectionOrder(u.w.owner, false)).toEqual([u.c[41], u.c[60], u.c[52]]);
});

scenario("Many drags between the same two rows keep a stable order", { tag: ["@browser"] }, async ({ server, page, context }, info) => {
  info.setTimeout(150_000);
  const u = await railWorld({ server, page, context });
  await openRail(page, u.w.srv);
  await expect(railGroup(page, "Conversations").locator(".rtitle")).toHaveText([T60, T52, T41]);

  // When the owner drags a conversation between the same two neighbours 80 times
  // (the last row goes between the first two each time, so the gap between those two halves every time and runs out of room)
  const made: number[] = [u.c[60], u.c[52], u.c[41]];
  for (let n = 1; n <= 80; n++) {
    const last = made.pop()!;
    made.splice(1, 0, last);
    if (n <= 3) {
      const titles = await titlesOf(page);
      await dragTo(page, railRow(page, titles[2]!), await between(railRow(page, titles[0]!), railRow(page, titles[1]!)));
      await expect.poll(() => sectionOrder(u.w.owner, false), { timeout: 5_000 }).toEqual(made);
    } else {
      // the same request the page sends for a drop
      await setPrefs(u.w.owner, last, { place: { after: made[0]! } });
    }

    // Then the rail order after each drag matches the order the owner made
    expect(await sectionOrder(u.w.owner, false), `after drag ${n}`).toEqual(made);
  }

  // And the order is the same after a reload
  await page.reload();
  const names = new Map([[u.c[41], T41], [u.c[52], T52], [u.c[60], T60]]);
  await expect(railGroup(page, "Conversations").locator(".rtitle")).toHaveText(made.map((id) => names.get(id)!));
});

scenario("Conversations with no message since yesterday fold into Older", { tag: ["@browser"] }, async ({ server, page, context, dataDir }) => {
  const u = await railWorld({ server, page, context });

  // Given conversation 41 is not starred and its last message was yesterday
  ageOf(dataDir, u.c[41], 1);

  // When the owner opens the rail
  await openRail(page, u.w.srv);

  // Then 41 sits in the collapsed group "Older · 1"
  const older = rail(page).getByRole("button", { name: "Older · 1" });
  await expect(older).toBeVisible();
  await expect(older).toHaveAttribute("aria-expanded", "false");
  await expect(railGroup(page, "Conversations").locator(".rtitle")).toHaveText([T60, T52]);
  await expect(railRow(page, T41)).toHaveCount(0);

  // And expanding "Older · 1" shows it
  await older.click();
  await expect(railGroup(page, "Older").locator(".rtitle")).toHaveText([T41]);
});

scenario("Only unstarred conversations with no message today fold into Older", { tag: ["@browser"] }, async ({ server, page, context, dataDir }) => {
  const u = await railWorld({ server, page, context });

  // Given conversation 52 is not starred and its last message was today

  // When the owner opens the rail
  await openRail(page, u.w.srv);

  // Then conversation 52 is in the Conversations group
  await expect(railGroup(page, "Conversations").locator(".rtitle")).toHaveText([T60, T52, T41]);
  await expect(rail(page).getByRole("button", { name: /^Older/ })).toHaveCount(0);

  // Given conversation 52 is starred and its last message was 40 days ago
  await setPrefs(u.w.owner, u.c[52], { starred: true });
  ageOf(dataDir, u.c[52], 40);

  // When the owner opens the rail
  await page.reload();

  // Then conversation 52 is in the Starred group
  await expect(railGroup(page, "Starred").locator(".rtitle")).toHaveText([T52]);
  await expect(rail(page).getByRole("button", { name: /^Older/ })).toHaveCount(0);
});

scenario("The row preview names the last writer", { tag: ["@browser"] }, async ({ server, page, context }) => {
  const u = await railWorld({ server, page, context });
  const preview = async (text: string) => {
    // When the owner opens the rail
    await page.goto(`${u.w.srv.origin}/chats`);
    // Then the row of 52 reads "<preview>"
    await expect(chatRow(page, T52).getByText(text, { exact: true })).toBeVisible();
  };

  // Given the last message in conversation 52 is nothing
  await preview("No messages yet");

  // Given the last message in conversation 52 is "Deploy finished" from the owner
  await ownerSays(u.w.owner, u.c[52], "Deploy finished");
  await preview("You: Deploy finished");

  // Given the last message in conversation 52 is "All checks green" from "devtool"
  await agentSays(u.w, "devtool", u.c[52], "All checks green");
  await preview("devtool: All checks green");
});

scenario("Back and forward move between visited conversations", { tag: ["@browser"] }, async ({ server, page, context }) => {
  const u = await railWorld({ server, page, context });

  // Given the owner opened 41, then 52, then 60
  await openRail(page, u.w.srv);
  for (const [title, id] of [[T41, u.c[41]], [T52, u.c[52]], [T60, u.c[60]]] as const) {
    await railRow(page, title).getByRole("link").click();
    await expect(page).toHaveURL(new RegExp(`/chats/${id}$`));
    await expect(page.getByRole("heading", { name: title, level: 1 })).toBeVisible();
    await rail(page).waitFor();
  }

  // When the owner presses Cmd+[ twice and then Cmd+]
  await page.keyboard.press("Meta+[");
  await expect(page).toHaveURL(new RegExp(`/chats/${u.c[52]}$`));
  await page.getByRole("heading", { name: T52, level: 1 }).waitFor();
  await page.keyboard.press("Meta+[");
  await expect(page).toHaveURL(new RegExp(`/chats/${u.c[41]}$`));
  await page.getByRole("heading", { name: T41, level: 1 }).waitFor();
  await page.keyboard.press("Meta+]");

  // Then conversation 52 is open
  await expect(page).toHaveURL(new RegExp(`/chats/${u.c[52]}$`));
  await expect(page.getByRole("heading", { name: T52, level: 1 })).toBeVisible();
});

scenario("Cmd+K opens search from anywhere", { tag: ["@browser"] }, async ({ server, page, context }) => {
  const u = await railWorld({ server, page, context });
  await openRail(page, u.w.srv, `/chats/${u.c[41]}`);
  await expect(page.getByRole("heading", { name: T41, level: 1 })).toBeVisible();

  // When the owner presses Cmd+K in conversation 41
  await page.keyboard.press("Meta+k");

  // Then the search box has focus
  const box = page.getByRole("dialog", { name: "Search" }).getByRole("combobox", { name: "Search" });
  await expect(box).toBeFocused();
});

scenario("The owner folds the sidebar and it stays folded", { tag: ["@browser"] }, async ({ server, page, context }) => {
  // Given the owner has conversation 41 open on a wide screen
  const u = await railWorld({ server, page, context });
  await openRail(page, u.w.srv, `/chats/${u.c[41]}`);
  await expect(page.getByRole("heading", { name: T41, level: 1 })).toBeVisible();
  const frameLeft = async () => (await page.locator(".chatframe").boundingBox())!.x;
  const wide = await frameLeft();

  // When the owner clicks "Hide sidebar"
  await rail(page).getByRole("button", { name: "Hide sidebar" }).click();

  // Then the rail is a thin strip with only "Show sidebar" and the conversation takes the room
  await expect(rail(page).getByRole("button", { name: "Show sidebar" })).toBeVisible();
  await expect(rail(page).getByRole("link")).toHaveCount(0);
  expect(await frameLeft()).toBeLessThan(wide - 150);

  // When the owner reloads the page, then the rail is still folded
  await page.reload();
  await expect(rail(page).getByRole("button", { name: "Show sidebar" })).toBeVisible();

  // When the owner presses Cmd+\, then the rail shows the conversations again
  await page.keyboard.press("Meta+Backslash");
  await expect(rail(page).getByRole("button", { name: "Hide sidebar" })).toBeVisible();
  await expect(railGroup(page, "Conversations").locator(".rtitle")).toHaveText([T60, T52, T41]);
  expect(await frameLeft()).toBe(wide);
});

scenario("The question mark opens the shortcut list", { tag: ["@browser"] }, async ({ server, page, context }) => {
  const u = await railWorld({ server, page, context });
  await openRail(page, u.w.srv, `/chats/${u.c[41]}`);
  const before = rail(page).getByRole("button", { name: "Search", exact: true });
  await before.focus();

  // When the owner presses "?"
  await page.keyboard.press("?");

  // Then the "Keyboard shortcuts" dialog lists every key
  const dialog = page.getByRole("dialog", { name: "Keyboard shortcuts" });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator("kbd")).toHaveText(["Cmd+K", "Cmd+J", "Cmd+[", "Cmd+]", "Cmd+\\", "Alt+ArrowUp", "Alt+ArrowDown", "I", "?", "Escape"]);

  // And Escape closes it and returns focus where it was
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(before).toBeFocused();
});

scenario("A conversation the owner never touched needs no preferences", { tag: ["@api"] }, async ({ server, dataDir }) => {
  const u = await apiRailWorld(server);

  // When the owner loads the rail
  const rows = await railRows(u.w.owner);

  // Then conversations 41, 52 and 60 come back with no star, no rank and no mute set
  expect(rows.map((c) => c.id).sort()).toEqual([u.c[41], u.c[52], u.c[60]].sort());
  for (const c of rows) {
    expect(c.starred, `${c.title} starred`).toBe(false);
    expect(c.muted_until, `${c.title} muted`).toBeUndefined();
    expect(c.rank, `${c.title} rank is its creation time`).toBe(c.created_at);
  }
  // and no preferences row was written for them
  expect(seedDb(dataDir, (db) => (db.prepare("SELECT COUNT(*) AS n FROM conversation_prefs").get() as { n: number }).n)).toBe(0);
});
