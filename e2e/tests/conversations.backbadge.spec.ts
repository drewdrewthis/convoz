import { agentAsks } from "../lib/asks.ts";
import { agentPosts, backBadge, backButton, composer, message, uiWorld } from "../lib/chat-ui.ts";
import { agentSays, createConversation, messagesOf, ownerReads } from "../lib/chat.ts";
import { expect, scenario } from "../lib/scenario.ts";

/** The chat on screen is "Ship search filters"; "docs" writes in the other one. */
async function openChat(fx: Parameters<typeof uiWorld>[0]) {
  const u = await uiWorld(fx, { live: ["devtool", "docs"] });
  const open = await createConversation(u.w.owner, { participants: ["devtool"], title: "Ship search filters" });
  const other = await createConversation(u.w.owner, { participants: ["docs"], title: "Write the runbook" });
  await fx.page.goto(`${u.w.srv.origin}/chats/${open}`);
  await expect(composer(fx.page)).toBeVisible();
  return { u, open, other };
}

// Owner (Drew, msg 114): "Maybe add like a little count badge on the back button from the conversation so I can see when there's a new response or thing to check it out from the feed or the inbox when I'm in a single conversation"
scenario("The Back button counts the other conversations with something new", { tag: ["@browser"] }, async ({ server, page, context }) => {
  const fx = { server, page, context };
  // Given the owner has read every conversation and has conversation 41 open
  const { u, open, other } = await openChat(fx);

  // Then the Back button has no count and is named "Back"
  await expect(backBadge(page)).toHaveCount(0);
  await expect(backButton(page)).toHaveAttribute("aria-label", "Back");

  // When "devtool" posts "Done" in conversation 41
  await agentPosts(u, "devtool", open, "Done");

  // Then the Back button still has no count
  await expect(message(page, "Done")).toBeVisible();
  await expect(backBadge(page)).toHaveCount(0);

  // When "docs" posts "Ready" in conversation 52
  await agentPosts(u, "docs", other, "Ready");

  // Then the Back button shows "1" within 3 seconds and is named "Back, 1 new"
  await expect(backBadge(page)).toHaveText("1", { timeout: 3_000 });
  await expect(backButton(page)).toHaveAttribute("aria-label", "Back, 1 new");

  // When "docs" posts "Again" in conversation 52
  await agentPosts(u, "docs", other, "Again");

  // Then the Back button still shows "1"
  await expect.poll(async () => (await messagesOf(u.w.owner, other)).length).toBe(2);
  await expect(backBadge(page)).toHaveText("1");

  // When the owner reads conversation 52 in another tab
  await ownerReads(u.w.owner, other, (await messagesOf(u.w.owner, other)).at(-1)!.id);

  // Then the Back button has no count within 3 seconds
  await expect(backBadge(page)).toHaveCount(0, { timeout: 3_000 });
  await expect(backButton(page)).toHaveAttribute("aria-label", "Back");
});

// Owner (Drew, msg 114): "…little count badge on the back button…"
scenario("A question waiting in the feed counts on the Back button", { tag: ["@browser"] }, async ({ server, page, context }) => {
  const fx = { server, page, context };
  // Given the owner has read every conversation and has conversation 41 open
  const { u, open } = await openChat(fx);
  await expect(backBadge(page)).toHaveCount(0);

  // When "devtool" asks a question in conversation 41
  await agentAsks(u.w.srv, u.sessions.devtool!.lease, open);

  // Then the Back button shows "1" within 3 seconds and is named "Back, 1 new"
  await expect(backBadge(page)).toHaveText("1", { timeout: 3_000 });
  await expect(backButton(page)).toHaveAttribute("aria-label", "Back, 1 new");
});

// Owner (Drew, msg 114): "…little count badge on the back button…"
scenario("The Back count stops at 99+", { tag: ["@browser"] }, async ({ server, page, context }) => {
  const fx = { server, page, context };
  // Given the owner has conversation 41 open and 100 other conversations with something new
  // One agent may post 20 messages in 20 seconds, so five agents write the 100.
  const agents = ["devtool", "docs", "build", "deploy", "release"];
  const u = await uiWorld(fx, { agents, live: agents });
  const open = await createConversation(u.w.owner, { participants: ["devtool"], title: "Ship search filters" });
  await Promise.all(
    agents.map(async (handle) => {
      for (let i = 0; i < 20; i++) {
        const conv = await createConversation(u.w.owner, { participants: [handle], title: `${handle} ${i}` });
        await agentSays(u.w.srv, u.sessions[handle]!.lease, conv, "New");
      }
    }),
  );
  await page.goto(`${u.w.srv.origin}/chats/${open}`);
  await expect(composer(page)).toBeVisible();

  // Then the Back button shows "99+" and is named "Back, 99+ new"
  await expect(backBadge(page)).toHaveText("99+");
  await expect(backButton(page)).toHaveAttribute("aria-label", "Back, 99+ new");
});
