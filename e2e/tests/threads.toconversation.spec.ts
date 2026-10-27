import { ROOT_TEXT, agentReplies, inlineThread, ownerReplies, threadWorld } from "../lib/threads-wp5.ts";
import { message } from "../lib/chat-ui.ts";
import { must } from "../lib/owner.ts";
import { expect, scenario } from "../lib/scenario.ts";

/*
 * TURN A THREAD INTO A CONVERSATION (owner, msgs 1591 and 2356, issue 32): the thread of a message gets "Turn into a conversation"
 * for the owner. It makes a new conversation titled by the root, with the same people, that says where it came from and links back.
 */

scenario("The owner turns a thread into a conversation and can go back to the thread", { tag: ["@browser"] }, async ({ server, page, context }) => {
  // Given the owner replied in thread 900 with "Can step 1 ship on its own?"
  const t = await threadWorld({ server, page, context }, { browser: true });
  await ownerReplies(t, "Can step 1 ship on its own?");
  await agentReplies(t, t.dev, "Yes, it needs no API.");
  await page.goto(`${t.w.srv.origin}/chats/${t.conv}`);
  const thread = inlineThread(page, ROOT_TEXT);

  // When the owner taps "Turn into a conversation" on the thread of message 900
  await thread.getByRole("button", { name: "Turn into a conversation" }).click();

  // Then a new conversation titled "Step 1 is the filter chips UI" opens with "devtool" and "docs" in it
  await expect(page).not.toHaveURL(new RegExp(`/chats/${t.conv}(#.*)?$`));
  await expect(page.getByRole("heading", { name: ROOT_TEXT })).toBeVisible();
  const made = Number(/\/chats\/(\d+)/.exec(page.url())![1]);
  const row = must(await t.w.owner.client.get(`/api/conversations/${made}`), "read the new conversation").json().conversation;
  expect(row.participants.map((p: { handle: string }) => p.handle)).toEqual(expect.arrayContaining(["devtool", "docs"]));

  // And the replies of the thread are its messages, by the same people
  await expect(message(page, "Can step 1 ship on its own?")).toBeVisible();
  await expect(message(page, "Yes, it needs no API.")).toBeVisible();

  // And it says "Started from a thread in Ship search filters"
  const from = page.getByRole("link", { name: "Started from a thread in Ship search filters" });
  await expect(from).toBeVisible();

  // When the owner taps that line
  await from.click();

  // Then conversation 41 opens at message 900
  await expect(page).toHaveURL(new RegExp(`/chats/${t.conv}#m${t.root}$`));

  // And the thread under message 900 has no replies left
  await expect(message(page, ROOT_TEXT)).toBeVisible();
  await expect(inlineThread(page, ROOT_TEXT)).toHaveCount(0);
  await expect(message(page, "Can step 1 ship on its own?")).toHaveCount(0);
});
