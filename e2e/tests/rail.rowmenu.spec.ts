import type { Locator, Page } from "@playwright/test";
import { chatList, chatRow } from "../lib/chat-ui.ts";
import { ownerSays } from "../lib/chat.ts";
import { agentSays, openRail, rail, railGroup, railRow, railWorld, TITLES } from "../lib/rail-wp9.ts";
import { expect, scenario } from "../lib/scenario.ts";
import { seedDb } from "../lib/wp3.ts";

/*
 * rail.feature, rule "Each rail row has a menu of actions" (owner, conv 179 msg 8722). THE PAGE the bindings rely on:
 *   Each rail row has a button "More actions for <title>" that opens a menu (role "menu") with the items Rename, Mark stale (Bring back when
 *   the row is under Older; a starred row has neither), Star (Unstar) and Mark read. Rename shows a text field named "Rename conversation": Enter saves, Escape cancels.
 *   On a phone (no rail) a long press on a row of the Conversations list opens the menu "Conversation actions" with the same Mark stale or
 *   Bring back; "Older · N" is a button that shows the list "Older conversations".
 */

const [T41, T52, T60] = TITLES;

async function pick(page: Page, title: string, item: string): Promise<void> {
  const row: Locator = railRow(page, title);
  await row.hover();
  await row.getByRole("button", { name: `More actions for ${title}` }).click();
  await page.getByRole("menuitem", { name: item, exact: true }).click();
}

/** The open menu is content-sized, starts at its dots button and stays inside the window. */
async function expectMenuFitsItsButton(page: Page, title: string): Promise<void> {
  const row = railRow(page, title);
  await row.hover();
  const button = row.getByRole("button", { name: `More actions for ${title}` });
  await button.click();
  const menu = page.getByRole("menu");
  const m = (await menu.boundingBox())!;
  const b = (await button.boundingBox())!;
  const view = page.viewportSize()!;
  expect(m.width, "menu width").toBeLessThanOrEqual(280);
  expect(Math.abs(m.x - b.x), "menu left edge against the dots button").toBeLessThanOrEqual(16);
  expect(m.x).toBeGreaterThanOrEqual(0);
  expect(m.x + m.width).toBeLessThanOrEqual(view.width);
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
}

async function open(fx: Parameters<typeof railWorld>[0]) {
  const u = await railWorld(fx);
  await openRail(fx.page, u.w.srv);
  return u;
}

scenario("The row menu renames a conversation", { tag: ["@browser"] }, async ({ server, page, context }) => {
  await open({ server, page, context });
  await pick(page, T52, "Rename");
  const field = page.getByRole("textbox", { name: "Rename conversation" });
  await field.fill("Runbook v2");
  await field.press("Enter");
  await expect(railRow(page, "Runbook v2")).toBeVisible();

  await pick(page, "Runbook v2", "Rename");
  await page.getByRole("textbox", { name: "Rename conversation" }).fill("Nope");
  await page.keyboard.press("Escape");
  await expect(railRow(page, "Runbook v2")).toBeVisible();
  await expect(railRow(page, "Nope")).toHaveCount(0);
});

const olderButton = (page: Page): Locator => railGroup(page, "Older").getByRole("button", { name: "Older · 1" });
const inConversations = (page: Page, title: string): Locator => railGroup(page, "Conversations").locator(".rtitle", { hasText: title });

scenario("The owner marks a conversation stale from its row menu", { tag: ["@browser"] }, async ({ server, page, context }) => {
  await open({ server, page, context });
  await pick(page, T52, "Mark stale");
  await expect(olderButton(page)).toBeVisible();
  await expect(inConversations(page, T52)).toHaveCount(0);

  await olderButton(page).click();
  await pick(page, T52, "Bring back");
  await expect(inConversations(page, T52)).toBeVisible();
});

scenario("The owner marks a conversation stale where he wrote last", { tag: ["@browser"] }, async ({ server, page, context }) => {
  const u = await open({ server, page, context });
  await ownerSays(u.w.owner, u.c[41], "Please check");
  await expect(railGroup(page, "Conversations").locator(".rtitle").first()).toHaveText(T41); // the new message moved the row to the top
  await pick(page, T41, "Mark stale");
  await expect(olderButton(page)).toBeVisible();
});

scenario("The owner brings a conversation back from Older", { tag: ["@browser"] }, async ({ server, page, context, dataDir }) => {
  const u = await railWorld({ server, page, context });
  // Given its last message was 2 days ago: the last activity moves back, the server clock stays
  seedDb(dataDir, (db) => db.prepare("UPDATE conversations SET last_activity_at = last_activity_at - ? WHERE id = ?").run(2 * 86_400_000, u.c[41]));
  await openRail(page, u.w.srv);
  await expect(olderButton(page)).toBeVisible();
  await expect(inConversations(page, T41)).toHaveCount(0);

  await olderButton(page).click();
  await pick(page, T41, "Bring back");
  await expect(inConversations(page, T41)).toBeVisible();
  await expect(railGroup(page, "Older")).toHaveCount(0);
  await page.reload();
  await expect(inConversations(page, T41)).toBeVisible();
});

scenario("On a phone the long press menu marks a conversation stale and brings it back", { tag: ["@browser", "@phone"] }, async ({ server, page, context }) => {
  const u = await railWorld({ server, page, context });
  await page.goto(`${u.w.srv.origin}/chats`);
  const longPress = async (row: Locator, item: string) => {
    await row.dispatchEvent("contextmenu");
    await page.getByRole("menu", { name: "Conversation actions" }).getByRole("menuitem", { name: item, exact: true }).click();
  };
  await longPress(chatRow(page, T52), "Mark stale");
  const older = page.getByRole("button", { name: "Older · 1" });
  await expect(older).toBeVisible();
  await expect(chatRow(page, T52)).toHaveCount(0);

  await older.click();
  const olderList = page.getByRole("list", { name: "Older conversations" });
  await longPress(olderList.getByRole("listitem").filter({ has: page.getByRole("heading", { name: T52, exact: true }) }), "Bring back");
  await expect(chatRow(page, T52)).toBeVisible();
  await expect(chatList(page).getByRole("heading")).toHaveText([T60, T52, T41]);
});

scenario("The row menu stars, unstars and marks read", { tag: ["@browser"] }, async ({ server, page, context }) => {
  const u = await open({ server, page, context });
  await agentSays(u.w, "devtool", u.c[60], "Report ready");
  await expect(railRow(page, T60).getByRole("link")).toHaveClass(/unread/);
  await pick(page, T60, "Mark read");
  await expectMenuFitsItsButton(page, T60);
  await expect(railRow(page, T60).getByRole("link")).not.toHaveClass(/unread/);

  await pick(page, T60, "Star");
  await expect(railGroup(page, "Starred").locator(".rtitle", { hasText: T60 })).toBeVisible();
  await pick(page, T60, "Unstar");
  await expect(railGroup(page, "Conversations").locator(".rtitle", { hasText: T60 })).toBeVisible();

  // Then the menu button stays clickable on a narrow rail: the resize handle on the rail edge does not take the click
  for (const narrow of [240, 200]) {
    await page.evaluate((w) => localStorage.setItem("convoz.rail.width", String(w)), narrow);
    await page.reload();
    await expect.poll(async () => Math.round((await rail(page).boundingBox())!.width)).toBe(narrow);
    await expectMenuFitsItsButton(page, T60);
    await pick(page, T60, "Star");
    await expect(railGroup(page, "Starred").locator(".rtitle", { hasText: T60 })).toBeVisible();
    await pick(page, T60, "Unstar");
    await expect(railGroup(page, "Conversations").locator(".rtitle", { hasText: T60 })).toBeVisible();
  }
});
