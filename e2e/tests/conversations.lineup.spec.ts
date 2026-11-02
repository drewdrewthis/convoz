import { agentPosts, uiWorld } from "../lib/chat-ui.ts";
import { createConversation } from "../lib/chat.ts";
import { showDetails } from "../lib/wp3.ts";
import { expect, scenario } from "../lib/scenario.ts";

// conversations.feature, the two "agent handle ... opens that agent" scenarios (issue 34).

async function openChat(fx: Parameters<typeof uiWorld>[0]) {
  const u = await uiWorld(fx, { live: ["devtool"] });
  const id = await createConversation(u.w.owner, { participants: ["devtool"], title: "Ship search filters" });
  await agentPosts(u, "devtool", id, "Filters are in");
  await fx.page.goto(`${u.w.srv.origin}/chats/${id}`);
  return u;
}

scenario("The agent handle under the title of a conversation opens that agent", { tag: ["@browser"] }, async ({ server, page, context }) => {
  // Given a conversation with "devtool" is open
  const u = await openChat({ server, page, context });

  // When the owner clicks the handle @devtool under the title
  await page.locator("#subtitle").getByRole("link", { name: "@devtool" }).click();

  // Then the agent page of "devtool" opens
  await expect(page).toHaveURL(`${u.w.srv.origin}/crew/devtool`);
});

scenario("The agent handle on its card in the details panel opens that agent", { tag: ["@browser"] }, async ({ server, page, context }) => {
  // Given a conversation with "devtool" is open with its details showing
  const u = await openChat({ server, page, context });
  const panel = await showDetails(page);

  // When the owner clicks the handle @devtool on its card
  await panel.getByRole("link", { name: "@devtool" }).click();

  // Then the agent page of "devtool" opens
  await expect(page).toHaveURL(`${u.w.srv.origin}/crew/devtool`);
});
