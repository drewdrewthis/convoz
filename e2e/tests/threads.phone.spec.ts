import type { Locator, Page } from "@playwright/test";
import { message } from "../lib/chat-ui.ts";
import { expect, scenario } from "../lib/scenario.ts";
import { ROOT_TEXT, replyBox, sendReply, threadLog, threadPane, threadWorld } from "../lib/threads-wp5.ts";

/*
 * THREADS ON A PHONE (owner, conv 9 msg 2708 on msg 2691): on his phone the owner could not open the thread of a message to reply in it.
 * A phone never hovers, so the "Message actions" button shows there at all times, and a long press on the message itself opens it too.
 */

/** A finger holds still on the middle of `target` until `shown` is visible, then lets go: raw touch events, as a phone sends them. */
async function longPress(page: Page, target: Locator, shown: Locator): Promise<void> {
  const box = (await target.boundingBox())!;
  const at = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [at] });
  await expect(shown).toBeVisible({ timeout: 2000 });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await cdp.detach();
}

scenario("On a phone a long press on a message opens Reply in thread", { tag: ["@browser", "@phone"] }, async ({ server, page, context }) => {
  // Given conversation 41 is open on a phone and message 900 has no replies
  const t = await threadWorld({ server, page, context }, { browser: true });
  await page.goto(`${t.w.srv.origin}/chats/${t.conv}`);
  const root = message(page, ROOT_TEXT);
  await expect(root).toBeVisible();

  // When the owner long presses the text of message 900
  const item = page.getByRole("menuitem", { name: /^Reply in thread/ });
  await longPress(page, root.getByText(ROOT_TEXT), item);

  // And taps "Reply in thread"
  await item.tap();

  // Then the reply box is open under message 900
  await expect(threadPane(page)).toBeVisible({ timeout: 2000 });

  // When the owner taps the reply box, types a reply and taps "Send reply"
  await replyBox(page).tap();
  await page.keyboard.type("Can step 1 ship on its own?");
  await sendReply(page).tap();

  // Then the thread shows the reply
  await expect(threadLog(page).getByRole("article").filter({ hasText: "Can step 1 ship on its own?" })).toBeVisible();
});

scenario("On a phone the message actions button shows and a tap on it opens Reply in thread", { tag: ["@browser", "@phone"] }, async ({ server, page, context }) => {
  // Given conversation 41 is open on a phone and message 900 has no replies
  const t = await threadWorld({ server, page, context }, { browser: true });
  await page.goto(`${t.w.srv.origin}/chats/${t.conv}`);
  const root = message(page, ROOT_TEXT);
  await expect(root).toBeVisible();

  // Then the "Message actions" button of message 900 shows without a hover (Playwright counts opacity 0 as visible, so the opacity is read)
  const actions = root.getByRole("button", { name: "Message actions" });
  await expect(actions).toHaveCSS("opacity", "1");

  // When the owner taps it and taps "Reply in thread"
  await actions.tap();
  await page.getByRole("menuitem", { name: /^Reply in thread/ }).tap();

  // Then the reply box is open under message 900
  await expect(threadPane(page)).toBeVisible({ timeout: 2000 });
});
