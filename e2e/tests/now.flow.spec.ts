import { agentSays, createConversation, ownerSays } from "../lib/chat.ts";
import { QUESTION, agentAsks, askCard, nowOf, openNow, ownerRepliesIn } from "../lib/asks.ts";
import { expect, scenario, test } from "../lib/scenario.ts";
import { threadPane } from "../lib/threads-wp5.ts";
import { browserWorld } from "../lib/wp3.ts";
import type { Page } from "@playwright/test";

/*
 * NOW, THE QUESTIONS-ASKED FLOW (owner, msgs 1117 and 1131; migration 0039): the bindings of the rule "Asks where the owner's reply is the last word wait
 * under You replied, and the thread opens inside the app" of specs/features/now.feature. The page contract (role, text and id locators):
 *   "You replied · waiting on the agent"   the heading of #replied; each row is a link holding the question, "Display Name @handle · <age>"
 *                                          and "You: <the first 100 characters of the reply>".
 *   Reply (the ask in Now)                 opens the ask's thread inside its item, with the box "Reply to the thread" in focus; the page stays.
 *   Reply (an unread card of Now)          goes to /chats/<id> the same way, with the composer focused.
 */

test.use({ timezoneId: "America/New_York" });

const WORLD = { agents: ["devtool", "docs"], live: ["devtool", "docs"] };
const OTHER = "Roll back box-3?";
const LONG = "I would like to understand the trade-offs here before I choose: which checks pass, which one is flaky, and what does holding it cost us this week? And one more thing: zzz";

/** A marker on the window and the page's time origin: both survive a navigation inside the app and neither survives a page load. */
async function mark(page: Page): Promise<number> {
  return page.evaluate(() => {
    (window as unknown as { __flow: number }).__flow = performance.timeOrigin;
    return performance.timeOrigin;
  });
}
const sameDocument = (page: Page, origin: number): Promise<boolean> => page.evaluate((o) => (window as unknown as { __flow?: number }).__flow === o && performance.timeOrigin === o, origin);

scenario("Asks the owner replied to wait in their own section", { tag: ["@browser"] }, async ({ server, page, context }, info) => {
  info.setTimeout(90_000);
  // Given an open ask of "devtool" that the owner replied to with a long reply, and an open ask of "docs" that the owner did not reply to
  const w = await browserWorld({ server, page, context }, WORLD);
  const conv = await createConversation(w.owner, { title: "Ship search filters", participants: ["devtool", "docs"] });
  const id = await agentAsks(w.srv, w.sessions.devtool!.lease, conv);
  await agentAsks(w.srv, w.sessions.docs!.lease, conv, { question: OTHER });
  await ownerRepliesIn(w.owner, conv, id, LONG);

  // When the owner opens Now
  await openNow(page, w.srv);

  // Then Now lists the ask of "docs" in the main list
  await expect(page.locator("#asks").getByRole("article", { name: OTHER })).toBeVisible();

  // And under "You replied · waiting on the agent" it lists the ask of "devtool" with the first 100 characters of the reply, then its question, then "@devtool" and its age
  const replied = page.locator("#replied");
  await expect(replied.getByText("You replied · waiting on the agent", { exact: true })).toBeVisible();
  const row = replied.getByRole("link");
  await expect(row).toHaveCount(1);
  // (the owner's own words lead, msg 2056)
  await expect(row).toContainText(`${LONG.slice(0, 100)}…On: ${QUESTION}`);
  await expect(row).not.toContainText(LONG.slice(0, 101));
  await expect(row).toContainText(/To Devtool @devtool · (now|\d+[mhd])( · \d+ repl(y|ies)(?: · \d+ new)?)?$/);

  // And the ask of "devtool" is not in the main list and does not count in the badge
  await expect(askCard(page, QUESTION)).toHaveCount(0);
  const now = await nowOf(w.owner);
  expect({ badge: now.badge, main: now.asks.length, replied: now.replied.map((a) => a.id) }).toEqual({ badge: 1, main: 1, replied: [id] });

  // When the owner taps the row
  const origin = await mark(page);
  await row.click();

  // Then the thread of the ask opens, under the ask
  await threadPane(page).waitFor();
  await expect(page.getByRole("log", { name: "Messages" })).toContainText(QUESTION);
  await expect(threadPane(page)).toContainText("which checks pass");
  expect(page.url()).toContain(`/chats/${conv}`);
  expect(await sameDocument(page, origin)).toBe(true);
});

scenario("Reply on an ask in Now opens its thread in place, and the ask moves at once", { tag: ["@browser"] }, async ({ server, page, context }, info) => {
  info.setTimeout(90_000);
  // Given an open ask of "devtool" in Now
  const w = await browserWorld({ server, page, context }, WORLD);
  const conv = await createConversation(w.owner, { title: "Ship search filters", participants: ["devtool", "docs"] });
  await agentAsks(w.srv, w.sessions.devtool!.lease, conv);
  await openNow(page, w.srv);
  await expect(askCard(page)).toBeVisible();
  const origin = await mark(page);

  // When the owner taps "Reply" on the ask in Now
  await askCard(page).getByRole("button", { name: "Reply", exact: true }).click();

  // Then the thread opens inside the ask with its reply box in focus, and the page was not loaded again
  const box = askCard(page).getByRole("textbox", { name: "Reply to the thread" });
  await expect(box).toBeFocused();
  expect(new URL(page.url()).pathname).toBe("/");
  expect(await sameDocument(page, origin)).toBe(true);

  // When the owner sends "Which runner?" from that box
  await box.fill("Which runner?");
  await askCard(page).getByRole("button", { name: "Send reply" }).click();

  // Then the ask is under "You replied · waiting on the agent" at once, without waiting for a poll
  const replied = page.locator("#replied");
  await expect(replied.getByRole("link", { name: new RegExp(QUESTION) })).toContainText("Which runner?On: ", { timeout: 2_000 });
  await expect(askCard(page)).toHaveCount(0);
  expect(await sameDocument(page, origin)).toBe(true);
});

scenario("An unread conversation in Now has a Reply action that focuses the composer", { tag: ["@browser"] }, async ({ server, page, context }, info) => {
  info.setTimeout(90_000);
  // Given the owner wrote "Are the filters in?" and "devtool" answered "The filters are in" in conversation 41
  const w = await browserWorld({ server, page, context }, WORLD);
  const conv = await createConversation(w.owner, { title: "Ship search filters", participants: ["devtool", "docs"] });
  await ownerSays(w.owner, conv, "Are the filters in?");
  await agentSays(w.srv, w.sessions.devtool!.lease, conv, "The filters are in");

  // When the owner opens Now with the mention and reply cards turned on and taps "Reply" on its card under "Replies to you"
  await openNow(page, w.srv, { cards: true });
  const origin = await mark(page);
  await page.getByRole("list", { name: "Replies to you" }).getByRole("listitem").filter({ hasText: "Ship search filters" }).getByRole("link", { name: "Reply", exact: true }).click();

  // Then conversation 41 opens inside the app and its composer has focus
  await expect(page.getByRole("textbox", { name: "Message", exact: true })).toBeFocused();
  expect(page.url()).toContain(`/chats/${conv}`);
  expect(await sameDocument(page, origin)).toBe(true);
});
