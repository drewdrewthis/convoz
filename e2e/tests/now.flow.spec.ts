import { agentSays, createConversation } from "../lib/chat.ts";
import { QUESTION, agentAsks, askCard, nowOf, openNow, ownerRepliesIn } from "../lib/asks.ts";
import { expect, scenario, test } from "../lib/scenario.ts";
import { replyBox, replyInThread, threadPane } from "../lib/threads-wp5.ts";
import { browserWorld } from "../lib/wp3.ts";
import type { Page } from "@playwright/test";

/*
 * NOW, THE QUESTIONS-ASKED FLOW (owner, msgs 1117 and 1131; migration 0039): the bindings of the rule "Asks the owner replied to wait
 * under You replied, and the thread opens inside the app" of specs/features/now.feature. The page contract (role, text and id locators):
 *   "You replied · waiting on the agent"   the heading of #replied; each row is a link holding the question, "Display Name @handle · <age>"
 *                                          and "You: <the first 100 characters of the reply>".
 *   Reply in thread (the ask in Now)       goes to /chats/<id> without loading a page (pushState), opens the thread and focuses its Reply box.
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

  // And under "You replied · waiting on the agent" it lists the ask of "devtool" with its question, "@devtool", the first 100 characters of the reply and its age
  const replied = page.locator("#replied");
  await expect(replied.getByText("You replied · waiting on the agent", { exact: true })).toBeVisible();
  const row = replied.getByRole("link");
  await expect(row).toHaveCount(1);
  await expect(row).toContainText(QUESTION);
  await expect(row).toContainText("@devtool");
  await expect(row).toContainText(`You: ${LONG.slice(0, 100)}…`);
  await expect(row).not.toContainText(LONG.slice(0, 101));
  await expect(row).toContainText(/@devtool · (now|\d+[mhd])( · \d+ repl(y|ies)(?: · \d+ new)?)?You: /);

  // And the ask of "devtool" is not in the main list and does not count in the badge
  await expect(askCard(page, QUESTION)).toHaveCount(0);
  const now = await nowOf(w.owner);
  expect({ badge: now.badge, main: now.asks.length, replied: now.replied.map((a) => a.id) }).toEqual({ badge: 1, main: 1, replied: [id] });

  // When the owner taps the row
  const origin = await mark(page);
  await row.click();

  // Then the thread of the ask opens
  await threadPane(page).waitFor();
  await expect(threadPane(page)).toContainText(QUESTION);
  await expect(threadPane(page)).toContainText("which checks pass");
  expect(page.url()).toContain(`/chats/${conv}`);
  expect(await sameDocument(page, origin)).toBe(true);
});

scenario("Reply in thread opens the thread without a page load, and the ask moves on return", { tag: ["@browser"] }, async ({ server, page, context }, info) => {
  info.setTimeout(90_000);
  // Given an open ask of "devtool" in Now
  const w = await browserWorld({ server, page, context }, WORLD);
  const conv = await createConversation(w.owner, { title: "Ship search filters", participants: ["devtool", "docs"] });
  await agentAsks(w.srv, w.sessions.devtool!.lease, conv);
  await openNow(page, w.srv);
  await expect(askCard(page)).toBeVisible();
  const origin = await mark(page);

  // When the owner taps "Reply in thread" on the ask in Now
  await askCard(page).getByRole("button", { name: "Reply in thread", exact: true }).click();

  // Then the thread opens and its Reply box has focus, and the page was not loaded again
  await threadPane(page).waitFor();
  await expect(replyBox(page)).toBeFocused();
  expect(page.url()).toContain(`/chats/${conv}`);
  expect(await sameDocument(page, origin)).toBe(true);

  // When the owner sends "Which runner?" in the thread and goes back to Now
  await replyInThread(page, "Which runner?");
  await expect(threadPane(page)).toContainText("Which runner?");
  await page.goBack();
  await page.getByRole("heading", { name: "Now", exact: true }).waitFor();

  // Then the ask is under "You replied · waiting on the agent" at once, without waiting for a poll
  const replied = page.locator("#replied");
  await expect(replied.getByRole("link", { name: new RegExp(QUESTION) })).toContainText("You: Which runner?", { timeout: 2_000 });
  await expect(askCard(page)).toHaveCount(0);
  expect(await sameDocument(page, origin)).toBe(true);
});

scenario("An unread conversation in Now has a Reply action that focuses the composer", { tag: ["@browser"] }, async ({ server, page, context }, info) => {
  info.setTimeout(90_000);
  // Given "devtool" posted a message in conversation 41 that the owner has not read
  const w = await browserWorld({ server, page, context }, WORLD);
  const conv = await createConversation(w.owner, { title: "Ship search filters", participants: ["devtool", "docs"] });
  await agentSays(w.srv, w.sessions.devtool!.lease, conv, "The filters are in");

  // When the owner opens Now and taps "Reply" on the unread card
  await openNow(page, w.srv);
  const origin = await mark(page);
  await page.getByRole("list", { name: "Unread conversations" }).getByRole("listitem").filter({ hasText: "Ship search filters" }).getByRole("link", { name: "Reply", exact: true }).click();

  // Then conversation 41 opens inside the app and its composer has focus
  await expect(page.getByRole("textbox", { name: "Message", exact: true })).toBeFocused();
  expect(page.url()).toContain(`/chats/${conv}`);
  expect(await sameDocument(page, origin)).toBe(true);
});
