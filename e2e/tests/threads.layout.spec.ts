import { agentSays } from "../lib/chat.ts";
import { message } from "../lib/chat-ui.ts";
import { expect, scenario } from "../lib/scenario.ts";
import { ROOT_TEXT, agentReplies, inlineThread, ownerReplies, threadWorld } from "../lib/threads-wp5.ts";

/*
 * THREAD LAYOUT: specs/features/threads.feature, Rule "A thread shows in the conversation under its root" (issue 83).
 * The owner's own message is a bubble on the right of the column; inside a thread it must start at the thread's left edge, like an
 * agent's reply, so the left half of a wide window is not empty. Numbers are the page's own boxes, in px.
 */

const NEAR = 64;

scenario("On a wide window the owner's thread reply starts at the left edge of the thread", { tag: ["@browser"] }, async ({ server, page, context }) => {
  // Background
  const t = await threadWorld({ server, page, context }, { browser: true });
  await page.setViewportSize({ width: 1440, height: 900 });

  // Given the owner and "devtool" replied in thread 900
  await ownerReplies(t, "Can step 1 ship on its own?");
  await agentReplies(t, t.dev, "Yes, it can");
  await agentSays(t.w.srv, t.dev, t.conv, "A newer note in the main list");

  // When the owner opens conversation 41 on a wide window
  await page.goto(`${t.w.srv.origin}/chats/${t.conv}`);
  await expect(message(page, "A newer note in the main list")).toBeVisible();
  const thread = inlineThread(page, ROOT_TEXT);
  const mine = thread.getByRole("article").filter({ hasText: "Can step 1 ship on its own?" });
  await expect(mine).toBeVisible();

  // Then the owner's reply starts within 64 px of the thread's left edge: its author line and its text
  const edge = (await thread.boundingBox())!.x;
  const text = (await mine.getByText("Can step 1 ship on its own?").boundingBox())!.x;
  const author = (await mine.locator(".byline").boundingBox())!.x;
  expect(text - edge, "the reply text's left offset").toBeLessThanOrEqual(NEAR);
  expect(author - edge, "the author line's left offset").toBeLessThanOrEqual(NEAR);

  // And it starts where the agent's reply starts
  const theirs = (await thread.getByRole("article").filter({ hasText: "Yes, it can" }).getByText("Yes, it can").boundingBox())!.x;
  expect(Math.abs(text - theirs), "the owner's and the agent's reply text").toBeLessThanOrEqual(NEAR);
});
