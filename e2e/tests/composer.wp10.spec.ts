import { agentPostWith, pageOf } from "../lib/messages-wp4.ts";
import { send } from "../lib/http.ts";
import { expect, scenario } from "../lib/scenario.ts";
import { dropFiles, filesToSend, openConversation, voiceWorld } from "../lib/ui-wp10.ts";
import { messageLog } from "../lib/chat-ui.ts";
import { must } from "../lib/owner.ts";
import { png, uploadWhole } from "../lib/uploads-wp10.ts";

/*
 * FILES IN THE COMPOSER (WP10): specs/features/composer.feature "Files attach by button or drop and bind once", the own-upload image of
 * security.feature and the agent avatar of crew.feature. The page contract is the block atop lib/ui-wp10.ts.
 */

const chart = { name: "chart.png", type: "image/png", bytes: png(16, 16, true) };
const logFile = { name: "deploy.log", type: "text/plain", bytes: Buffer.from("deploy ok\n".repeat(200)) };

scenario("Dropping files attaches them to the next message", { tag: ["@browser"] }, async ({ server, page, context }) => {
  // Background
  const u = await voiceWorld({ server, page, context });
  await openConversation(page, u.w.srv, u.conv);

  // When the owner drops "chart.png" and "deploy.log" on conversation 41
  await dropFiles(page, [chart, logFile]);

  // Then the composer shows both under "Files to send"
  const list = filesToSend(page);
  await expect(list.getByRole("listitem")).toHaveCount(2);
  await expect(list).toContainText("chart.png");
  await expect(list).toContainText("deploy.log");
  await expect(page.getByRole("progressbar", { name: /^Uploading / })).toHaveCount(0, { timeout: 20_000 });

  // And sending posts one message with both files
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(messageLog(page).getByRole("article")).toHaveCount(1);
  await expect(list).toHaveCount(0);
  const posted = await pageOf(u.w.owner, u.conv);
  expect(posted).toHaveLength(1);
  expect(posted[0]!.uploads!.map((x) => x.name)).toEqual(["chart.png", "deploy.log"]);
  await expect(messageLog(page).getByText("deploy.log")).toBeVisible();
});

scenario("The owner removes a file before sending", { tag: ["@browser"] }, async ({ server, page, context }) => {
  // Background
  const u = await voiceWorld({ server, page, context });
  await openConversation(page, u.w.srv, u.conv);

  // Given "chart.png" and "deploy.log" wait under "Files to send"
  await dropFiles(page, [chart, logFile]);
  await expect(filesToSend(page).getByRole("listitem")).toHaveCount(2);

  // When the owner removes "deploy.log"
  await page.getByRole("button", { name: "Remove deploy.log" }).click();
  await expect(filesToSend(page).getByRole("listitem")).toHaveCount(1);
  await expect(page.getByRole("progressbar", { name: /^Uploading / })).toHaveCount(0, { timeout: 20_000 });

  // Then sending posts one message with only "chart.png"
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(messageLog(page).getByRole("article")).toHaveCount(1);
  const posted = await pageOf(u.w.owner, u.conv);
  expect(posted).toHaveLength(1);
  expect(posted[0]!.uploads!.map((x) => x.name)).toEqual(["chart.png"]);
});

scenario("More than 10 attachments are refused in the composer", { tag: ["@browser"] }, async ({ server, page, context }) => {
  // Background
  const u = await voiceWorld({ server, page, context });
  await openConversation(page, u.w.srv, u.conv);

  // When the owner drops 11 files on conversation 41
  const eleven = Array.from({ length: 11 }, (_, i) => ({ name: `note-${i + 1}.txt`, type: "text/plain", bytes: Buffer.from(`note ${i + 1}`) }));
  await dropFiles(page, eleven);

  // Then the composer keeps 10 and says that 10 is the most per message
  await expect(filesToSend(page).getByRole("listitem")).toHaveCount(10);
  await expect(page.getByRole("status").filter({ hasText: "10 is the most per message." })).toBeVisible();
  await expect(filesToSend(page)).not.toContainText("note-11.txt");
});

scenario("An image from an own upload renders inline", { tag: ["@browser"] }, async ({ server, page, context }) => {
  // Background
  const u = await voiceWorld({ server, page, context });

  // Given "devtool" uploaded "chart.png"
  const agent = { srv: u.w.srv, lease: u.devtool.lease };
  const up = await uploadWhole(agent, u.conv, "image", "chart.png", png(24, 24, true));

  // When it posts markdown that shows that upload as an image
  must(await agentPostWith(u.w.srv, u.devtool.lease, u.conv, { body: `![chart](/api/files/${up.id})`, upload_ids: [up.id] }), "post", 201);
  await openConversation(page, u.w.srv, u.conv);

  // Then the owner sees the image in the conversation
  const img = messageLog(page).getByRole("img", { name: "chart", exact: true });
  await expect(img).toBeVisible();
  await expect.poll(() => img.evaluate((e: HTMLImageElement) => e.naturalWidth)).toBe(24);
  expect(await img.getAttribute("src")).toBe(`/api/files/${up.id}`);
});

scenario("An agent's own avatar shows safely", { tag: ["@browser"] }, async ({ server, page, context }) => {
  // Background
  const u = await voiceWorld({ server, page, context });

  // Given "devtool" set an SVG avatar of plain shapes
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="5" fill="#2a7"/><rect x="3" y="3" width="4" height="4" fill="#fff"/></svg>';
  must(await send(u.w.srv.target, "PATCH", "/api/me/profile", { json: { avatar_svg: svg }, headers: { Authorization: `Bearer ${u.devtool.lease}` } }), "set avatar");

  // When the owner opens Crew
  await page.goto(`${u.w.srv.origin}/crew`);
  await expect(page.getByRole("heading", { name: "Crew", exact: true })).toBeVisible();

  // Then the avatar shows next to "@devtool"
  const img = page.locator('img[alt="@devtool avatar"]').first();
  await expect(img).toBeVisible();
  await expect.poll(() => img.evaluate((e: HTMLImageElement) => e.naturalWidth)).toBeGreaterThan(0);
  expect(await img.getAttribute("src")).toMatch(/^\/api\/identities\/\d+\/avatar\.svg$/);
});
