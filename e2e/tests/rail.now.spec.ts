import type { Locator, Page } from "@playwright/test";
import { QUESTION, agentAsks } from "../lib/asks.ts";
import { TITLES, openRail, rail, railGroup, railWorld } from "../lib/rail-wp9.ts";
import { expect, scenario } from "../lib/scenario.ts";

/*
 * rail.feature, rule "On a wide screen Now is a view of the rail" (owner, conv 179; UX plan §1). THE PAGE the bindings rely on:
 *   At 900 px or more the rail (navigation "Conversations") has a toggle button "Now" (aria-pressed; its name ends with the count).
 *   Pressed, the rail is 360 px wide (240 px otherwise), shows the Now list instead of the groups, and starts with a button
 *   "Conversations" that switches back; Escape with the focus in the rail and Cmd+. switch too. The page keeps the open conversation.
 *   Each open ask of the list is an article named by its question inside an item [data-conv=<conversation id>]; the item of the
 *   conversation open in the page has aria-current="page". The mode is kept in localStorage "convoz.rail.mode" ("now" | "conversations").
 *   Under 900 px there is no rail and Now is the full-screen page at /, whatever the stored mode (bound in now.wp8.spec.ts,
 *   "The badge counts open asks that are not snoozed").
 */

const [T41, , T60] = TITLES;
const OTHER = "Roll back box-3?";

const nowButton = (page: Page): Locator => rail(page).getByRole("button", { name: /^Now\b/ });
const railAsk = (page: Page, question: string): Locator => rail(page).getByRole("article", { name: question });
/** The Now item (the ask with what goes with it) of an ask in the rail. */
const railItem = (page: Page, question: string): Locator => rail(page).locator("[data-conv]").filter({ has: page.getByRole("article", { name: question }) });
const railWidth = async (page: Page): Promise<number> => Math.round((await rail(page).boundingBox())!.width);
const frameLeft = async (page: Page): Promise<number> => (await page.locator(".chatframe").boundingBox())!.x;
const openHeading = (page: Page, title: string): Locator => page.getByRole("heading", { name: title, level: 1 });

/** Background plus an ask of "devtool" in conversation 52, and conversation 41 open on a 1280 px wide screen. */
async function waitingWorld(fx: Parameters<typeof railWorld>[0]) {
  const u = await railWorld(fx);
  await agentAsks(u.w.srv, u.w.sessions.devtool!.lease, u.c[52]);
  return u;
}

async function openWithNow(page: Page, u: Awaited<ReturnType<typeof railWorld>>): Promise<void> {
  await openRail(page, u.w.srv, `/chats/${u.c[41]}`);
  await expect(openHeading(page, T41)).toBeVisible();
  await nowButton(page).click();
  await expect(railAsk(page, QUESTION)).toBeVisible();
}

async function expectConversationsRail(page: Page): Promise<void> {
  await expect(railGroup(page, "Conversations")).toBeVisible();
  await expect(railAsk(page, QUESTION)).toHaveCount(0);
  await expect.poll(() => railWidth(page)).toBe(240);
}

scenario("Now opens in the rail beside the open conversation", { tag: ["@browser"] }, async ({ server, page, context }) => {
  // Given "devtool" asks in conversation 52, and the owner has conversation 41 open on a 1280 px wide screen
  const u = await waitingWorld({ server, page, context });
  await openRail(page, u.w.srv, `/chats/${u.c[41]}`);
  await expect(openHeading(page, T41)).toBeVisible();
  const url = page.url();
  expect(await railWidth(page)).toBe(240);

  // When the owner clicks "Now" in the rail
  await nowButton(page).click();

  // Then the rail lists the ask and no Conversations group
  await expect(railAsk(page, QUESTION)).toBeVisible();
  await expect(railGroup(page, "Conversations")).toHaveCount(0);
  await expect(nowButton(page)).toHaveAttribute("aria-pressed", "true");

  // And the rail is about 360 px wide and the conversation moves with it
  await expect.poll(() => railWidth(page)).toBe(360);
  expect(await frameLeft(page)).toBeGreaterThanOrEqual(360);

  // And conversation 41 is still open in the page
  await expect(openHeading(page, T41)).toBeVisible();
  expect(page.url()).toBe(url);
});

scenario("Picking a Now item opens its conversation beside the Now list", { tag: ["@browser"] }, async ({ server, page, context }) => {
  // Given asks in conversations 52 and 60, and conversation 41 open with Now in the rail
  const u = await waitingWorld({ server, page, context });
  await agentAsks(u.w.srv, u.w.sessions.devtool!.lease, u.c[60], { question: OTHER });
  await openWithNow(page, u);
  await expect(railAsk(page, OTHER)).toBeVisible();

  // When the owner picks "Open" on the ask of conversation 60 in the rail
  await railAsk(page, OTHER).getByRole("link", { name: "Open", exact: true }).click();

  // Then conversation 60 is open in the page
  await expect(openHeading(page, T60)).toBeVisible();
  expect(new URL(page.url()).pathname).toBe(`/chats/${u.c[60]}`);

  // And the rail still lists both asks
  await expect(railAsk(page, QUESTION)).toBeVisible();
  await expect(railAsk(page, OTHER)).toBeVisible();

  // And the item of conversation 60 is marked as current and the item of conversation 52 is not
  await expect(railItem(page, OTHER)).toHaveAttribute("aria-current", "page");
  await expect(railItem(page, QUESTION)).not.toHaveAttribute("aria-current");
});

scenario("Conversations, Escape and Now again each take the rail back to the conversations", { tag: ["@browser"] }, async ({ server, page, context }) => {
  // Given an ask in conversation 52, and conversation 41 open with Now in the rail
  const u = await waitingWorld({ server, page, context });
  await openWithNow(page, u);
  const url = page.url();

  // When the owner clicks "Conversations" at the top of the rail, then the rail lists the Conversations group at 240 px
  await rail(page).getByRole("button", { name: "Conversations", exact: true }).click();
  await expectConversationsRail(page);

  // When the owner presses Cmd+. and then Escape with the focus in the rail, then the rail lists the Conversations group at 240 px
  await page.keyboard.press("Meta+Period");
  await expect(railAsk(page, QUESTION)).toBeVisible();
  await expect.poll(() => railWidth(page)).toBe(360);
  await railAsk(page, QUESTION).getByRole("link", { name: "Open", exact: true }).focus();
  await page.keyboard.press("Escape");
  await expectConversationsRail(page);
  await expect(nowButton(page)).toBeFocused();

  // When the owner clicks "Now" twice, then the rail lists the Conversations group at 240 px
  await nowButton(page).click();
  await expect(railAsk(page, QUESTION)).toBeVisible();
  await nowButton(page).click();
  await expectConversationsRail(page);

  // And conversation 41 stayed open the whole time
  await expect(openHeading(page, T41)).toBeVisible();
  expect(page.url()).toBe(url);
});

scenario("The rail stays in Now after a reload", { tag: ["@browser"] }, async ({ server, page, context }) => {
  // Given an ask in conversation 52, and conversation 41 open with Now in the rail
  const u = await waitingWorld({ server, page, context });
  await openWithNow(page, u);

  // When the owner reloads the page
  await page.reload();

  // Then the rail still lists the ask and is about 360 px wide
  await expect(railAsk(page, QUESTION)).toBeVisible();
  await expect(nowButton(page)).toHaveAttribute("aria-pressed", "true");
  await expect.poll(() => railWidth(page)).toBe(360);
  await expect(openHeading(page, T41)).toBeVisible();
});
