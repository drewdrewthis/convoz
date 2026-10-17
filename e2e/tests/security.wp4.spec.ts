import { messageLog } from "../lib/chat-ui.ts";
import { signInBrowser } from "../lib/machines.ts";
import { agentPostWith, leaseOf, msgWorld } from "../lib/messages-wp4.ts";
import { must } from "../lib/owner.ts";
import { expect, scenario } from "../lib/scenario.ts";

/*
 * LINKS IN MESSAGES (WP4): what the owner's page makes of a link in an agent's markdown (I-45). The page draws a link only for
 * http, https and mailto; every other target stays text. A link whose label is plain words shows its real host beside it, and every
 * link opens with rel "noopener noreferrer" in a new tab.
 */

scenario("Dangerous link schemes render as text", { tag: ["@browser"] }, async ({ server, dataDir, page, context }) => {
  // Background
  const w = await msgWorld({ server, dataDir });
  await signInBrowser(w.srv, w.owner, page, context);
  const lease = await leaseOf(w, "devtool");
  await page.goto(`${w.srv.origin}/chats/${w.conv}`);

  const targets = ["javascript:alert(1)", "java&#115;cript:alert(1)", "java\tscript:alert(1)", "data:text/html,<b>x</b>"];
  for (const [i, target] of targets.entries()) {
    // When "devtool" posts a link to <target>
    const body = `Row ${i + 1}: [open it](${target})`;
    must(await agentPostWith(w.srv, lease, w.conv, { body, format: "markdown" }), `post row ${i + 1}`, 201);

    // Then the owner sees it as plain text, not a link
    const shown = messageLog(page).getByRole("article").filter({ hasText: `Row ${i + 1}:` });
    await expect(shown).toBeVisible();
    await expect(shown).toContainText(`[open it](${target})`);
    await expect(shown.locator("a")).toHaveCount(0);
    await expect(shown.locator("b")).toHaveCount(0); // "<b>x</b>" is text, not markup
  }
});

scenario("An external link shows its real host", { tag: ["@browser"] }, async ({ server, dataDir, page, context }) => {
  // Background
  const w = await msgWorld({ server, dataDir });
  await signInBrowser(w.srv, w.owner, page, context);
  const lease = await leaseOf(w, "devtool");
  await page.goto(`${w.srv.origin}/chats/${w.conv}`);

  // When "devtool" posts "[docs](https://evil.example/login)"
  must(await agentPostWith(w.srv, lease, w.conv, { body: "[docs](https://evil.example/login)", format: "markdown" }), "post", 201);

  // Then the owner sees the host "evil.example" next to "docs"
  const shown = messageLog(page).getByRole("article").filter({ hasText: "docs" });
  await expect(shown.getByRole("link", { name: "docs" })).toBeVisible();
  await expect(shown.locator(".host")).toHaveText("evil.example");
  await expect(shown.locator(".text")).toHaveText("docsevil.example"); // the page draws the space and the parentheses around the host
  expect(await shown.locator(".host").evaluate((e) => getComputedStyle(e, "::before").content + getComputedStyle(e, "::after").content)).toBe('" ("")"');

  // And the link has rel "noopener noreferrer"
  await expect(shown.getByRole("link", { name: "docs" })).toHaveAttribute("rel", "noopener noreferrer");
  await expect(shown.getByRole("link", { name: "docs" })).toHaveAttribute("href", "https://evil.example/login");
});
