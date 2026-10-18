import { agentPosts, composer, fromBottom, message, messageLog, uiWorld } from "../lib/chat-ui.ts";
import { createConversation, ownerSays, unreadOf } from "../lib/chat.ts";
import { expect, scenario } from "../lib/scenario.ts";

const line = (page: import("@playwright/test").Page) => page.getByRole("separator", { name: "New messages" });
const top = async (l: import("@playwright/test").Locator) => (await l.boundingBox())!.y;

// Owner (Drew, msg 159): "You can see it's difficult to tell there are new messages"
scenario("A New messages line marks where unread began and stays while the chat is open", { tag: ["@browser"] }, async ({ server, page, context }) => {
  // Given "devtool" posted "First news", "Second news" and "Third news" in conversation 41 while the owner was away
  const u = await uiWorld({ server, page, context });
  const conv = await createConversation(u.w.owner, { participants: ["devtool"], title: "Ship search filters" });
  for (const text of ["First news", "Second news", "Third news"]) await agentPosts(u, "devtool", conv, text);

  // When the owner opens conversation 41
  await page.goto(`${u.w.srv.origin}/chats/${conv}`);
  await expect(message(page, "Third news")).toBeVisible();

  // Then a "New messages" line shows above "First news"
  await expect(line(page)).toHaveCount(1);
  const first = message(page, "First news");
  expect(await top(line(page))).toBeLessThan(await top(first));

  // And the line is not above "Second news" or "Third news"
  const gap = (await top(first)) - (await top(line(page)));
  expect(gap).toBeGreaterThan(0);
  expect(gap).toBeLessThan(60); // nothing else sits between the line and "First news"
  expect(await top(line(page))).toBeLessThan(await top(message(page, "Second news")));

  // When "devtool" posts "Fourth news" in conversation 41
  await agentPosts(u, "devtool", conv, "Fourth news");

  // Then the "New messages" line is still above "First news" and shows only once
  await expect(message(page, "Fourth news")).toBeVisible({ timeout: 3_000 });
  await expect(line(page)).toHaveCount(1);
  expect(await top(line(page))).toBeLessThan(await top(first));

  // When the owner leaves and opens conversation 41 again
  await expect.poll(() => unreadOf(u.w.owner, conv)).toBe(0);
  await page.goto(`${u.w.srv.origin}/chats/${conv}`);
  await expect(message(page, "Fourth news")).toBeVisible();

  // Then no "New messages" line shows
  await expect(line(page)).toHaveCount(0);
});

// Owner (Drew, msg 159): "You can see it's difficult to tell there are new messages"
scenario("Messages by one author more than 5 minutes apart are separate groups with their time", { tag: ["@browser"] }, async ({ server, testApi, page, context }) => {
  // Given "devtool" posted "Early" and then 6 minutes later "Late" and "Later" in conversation 41
  const u = await uiWorld({ server, page, context });
  const conv = await createConversation(u.w.owner, { participants: ["devtool"], title: "Ship search filters" });
  await agentPosts(u, "devtool", conv, "Early");
  await testApi(u.w.srv).advanceClock(6 * 60_000);
  await agentPosts(u, "devtool", conv, "Late");
  await agentPosts(u, "devtool", conv, "Later");

  // When the owner opens conversation 41
  await page.goto(`${u.w.srv.origin}/chats/${conv}`);
  await expect(message(page, "Later")).toBeVisible();

  // Then "Early" and "Late" each show with the author's name and time
  for (const text of ["Early", /\bLate\b/]) {
    await expect(message(page, text)).toContainText("@devtool");
    await expect(message(page, text).locator("time")).toBeVisible();
  }

  // And "Later" shows without its own name or time
  await expect(message(page, "Later").locator("time")).toHaveCount(0);
  await expect(message(page, "Later")).not.toContainText("@devtool");
});

// Owner (Drew, msg 159): "You can see it's difficult to tell there are new messages"
scenario("A pill counts new messages while the owner reads above and jumps to the first of them", { tag: ["@browser"] }, async ({ server, page, context }) => {
  // Given the owner scrolled up in a long conversation 41
  const u = await uiWorld({ server, page, context });
  const conv = await createConversation(u.w.owner, { participants: ["devtool"], title: "Ship search filters" });
  for (let n = 1; n <= 40; n++) await ownerSays(u.w.owner, conv, `msg-${String(n).padStart(3, "0")} ${"words ".repeat(12)}`);
  await page.goto(`${u.w.srv.origin}/chats/${conv}`);
  const log = messageLog(page);
  await expect.poll(() => fromBottom(log)).toBeLessThanOrEqual(2);
  await log.evaluate((e) => (e.scrollTop = 0));
  const before = await log.evaluate((e) => e.scrollTop);
  const pill = page.getByText(/^↓ \d+ new$/);

  // When "devtool" posts "Fresh one" and "Fresh two" in conversation 41
  await agentPosts(u, "devtool", conv, "Fresh one");
  await agentPosts(u, "devtool", conv, "Fresh two");

  // Then a pill reading "↓ 2 new" shows and the page does not move
  await expect(page.getByText("↓ 2 new", { exact: true })).toBeVisible({ timeout: 3_000 });
  expect(Math.abs((await log.evaluate((e) => e.scrollTop)) - before)).toBeLessThanOrEqual(2);

  // When the owner taps the pill
  await page.getByText("↓ 2 new", { exact: true }).click();

  // Then "Fresh one" is in view and the pill is gone
  await expect(message(page, "Fresh one")).toBeInViewport();
  await expect(pill).toBeHidden();
});

// Owner (Drew, msg 159): "You can see it's difficult to tell there are new messages"
scenario("Nothing shows through the name and buttons at the top", { tag: ["@browser"] }, async ({ server, page, context }) => {
  // Given the owner has conversation 41 open and scrolled so that messages pass under the name and buttons at the top
  const u = await uiWorld({ server, page, context });
  const conv = await createConversation(u.w.owner, { participants: ["devtool"], title: "Ship search filters" });
  for (let n = 1; n <= 40; n++) await ownerSays(u.w.owner, conv, `msg-${String(n).padStart(3, "0")} ${"words ".repeat(12)}`);
  await page.goto(`${u.w.srv.origin}/chats/${conv}`);
  await expect(composer(page)).toBeVisible();
  const log = messageLog(page);
  await expect.poll(() => fromBottom(log)).toBeLessThanOrEqual(2);
  await log.evaluate((e) => (e.scrollTop = e.scrollHeight / 2));
  const title = page.getByRole("heading", { name: "Ship search filters", exact: true });
  const titles = title.locator("xpath=..");

  // Then the title area belongs to the top of the conversation and not to a message behind it
  const hit = await title.evaluate((h) => {
    const r = h.getBoundingClientRect();
    return document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)?.closest("header") !== null;
  });
  expect(hit).toBe(true);

  // And the title area looks the same with the messages hidden
  const withMessages = await titles.screenshot();
  await log.evaluate((e) => (e.style.visibility = "hidden"));
  const without = await titles.screenshot();
  expect(Buffer.compare(withMessages, without)).toBe(0);
});
