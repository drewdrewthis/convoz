import { agentPosts, composer, message, uiWorld } from "../lib/chat-ui.ts";
import { createConversation } from "../lib/chat.ts";
import { test } from "@playwright/test";
import { expect, scenario } from "../lib/scenario.ts";

/** Two conversations, each with one message; the first is open. */
async function twoChats(fx: Parameters<typeof uiWorld>[0]) {
  const u = await uiWorld(fx, { live: ["devtool", "docs"] });
  const a = await createConversation(u.w.owner, { participants: ["devtool"], title: "Ship search filters" });
  const b = await createConversation(u.w.owner, { participants: ["docs"], title: "Write the runbook" });
  await agentPosts(u, "devtool", a, "Filters are in");
  await agentPosts(u, "docs", b, "Runbook draft up");
  await fx.page.goto(`${u.w.srv.origin}/chats/${a}`);
  await expect(message(fx.page, "Filters are in")).toBeVisible();
  // A mark on the window: a document load clears it, an in-app route change keeps it.
  await fx.page.evaluate(() => ((window as { czNoReload?: boolean }).czNoReload = true));
  return { u, a, b };
}

const noReload = (page: Parameters<typeof uiWorld>[0]["page"]) => page.evaluate(() => (window as { czNoReload?: boolean }).czNoReload === true);

// Owner (Drew, conv 202): a conversation he leaves and reopens shows at once, not after several seconds.
scenario("A conversation link in the sidebar switches the conversation in place", { tag: ["@browser"] }, async ({ server, page, context }, info) => {
  test.skip(info.project.name === "mobile", "the sidebar is a desktop layout");
  const fx = { server, page, context };
  // Given conversation A is open
  const { u, a, b } = await twoChats(fx);

  // When the owner clicks conversation B in the sidebar
  await page.locator(`#rr-${b}`).click();

  // Then B shows, the URL is /chats/B, and the page did not reload
  await expect(message(page, "Runbook draft up")).toBeVisible();
  await expect(page).toHaveURL(`${u.w.srv.origin}/chats/${b}`);
  expect(await noReload(page)).toBe(true);

  // When the owner clicks conversation A again
  await page.locator(`#rr-${a}`).click();

  // Then A shows again without a reload
  await expect(message(page, "Filters are in")).toBeVisible();
  await expect(page).toHaveURL(`${u.w.srv.origin}/chats/${a}`);
  expect(await noReload(page)).toBe(true);

  // When the owner presses Back
  await page.goBack();

  // Then B shows, still without a reload
  await expect(page).toHaveURL(`${u.w.srv.origin}/chats/${b}`);
  await expect(message(page, "Runbook draft up")).toBeVisible();
  expect(await noReload(page)).toBe(true);

  // When the owner reloads the page
  await page.reload();

  // Then B shows again
  await expect(message(page, "Runbook draft up")).toBeVisible();
  await expect(composer(page)).toBeVisible();
});

scenario("A deep link opens its conversation", { tag: ["@browser"] }, async ({ server, page, context }) => {
  const fx = { server, page, context };
  // Given two conversations
  const { u, b } = await twoChats(fx);

  // When the owner opens /chats/B in a new tab
  const tab = await context.newPage();
  await tab.goto(`${u.w.srv.origin}/chats/${b}`);

  // Then B shows
  await expect(message(tab, "Runbook draft up")).toBeVisible();
  await expect(composer(tab)).toBeVisible();
});
