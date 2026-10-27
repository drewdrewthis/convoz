import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { agentPostWith, pageOf } from "../lib/messages-wp4.ts";
import { send } from "../lib/http.ts";
import { expect, scenario } from "../lib/scenario.ts";
import { dropFiles, filesToSend, openConversation, pasteFiles, voiceWorld } from "../lib/ui-wp10.ts";
import { messageLog } from "../lib/chat-ui.ts";
import { convoz, ownerSays } from "../lib/chat.ts";
import { openThread, replyBox, sendReply, threadPane } from "../lib/threads-wp5.ts";
import { must } from "../lib/owner.ts";
import { png, uploadWhole } from "../lib/uploads-wp10.ts";

/*
 * FILES IN THE COMPOSER (WP10): specs/features/composer.feature "Files attach by button or drop and bind once", the own-upload image of
 * security.feature and the agent avatar scenarios of crew.feature. The page contract is the block atop lib/ui-wp10.ts.
 */

const chart = { name: "chart.png", type: "image/png", bytes: png(16, 16, true) };
const logFile = { name: "deploy.log", type: "text/plain", bytes: Buffer.from("deploy ok\n".repeat(200)) };

scenario("Dropping files attaches them to the next message", { tag: ["@browser"], fixme: "https://github.com/drewdrewthis/convoz/issues/134" }, async ({ server, page, context }) => {
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

scenario("Dropping files on a thread attaches them to the reply", { tag: ["@browser"], fixme: "https://github.com/drewdrewthis/convoz/issues/134" }, async ({ server, page, context }) => {
  // Given conversation 41 is open with a thread on its first message, and the thread is open (owner, msg 1855: "cannot drop into threads")
  const u = await voiceWorld({ server, page, context });
  const root = await ownerSays(u.w.owner, u.conv, FIRST_MESSAGE);
  await openConversation(page, u.w.srv, u.conv);
  await expect(messageLog(page).getByText(FIRST_MESSAGE)).toBeVisible();
  await openThread(page, FIRST_MESSAGE);

  // When the owner drops "chart.png" and "deploy.log" on the thread
  await dropFiles(page, [chart, logFile], threadPane(page));

  // Then the thread's reply box shows both under "Files to send", and the conversation's composer shows none
  const inThread = threadPane(page).getByRole("list", { name: "Files to send" });
  await expect(inThread.getByRole("listitem")).toHaveCount(2);
  await expect(inThread).toContainText("chart.png");
  await expect(inThread).toContainText("deploy.log");
  await expect(filesToSend(page)).toHaveCount(1);

  // And sending posts one reply with both files
  await expect(page.getByRole("progressbar", { name: /^Uploading / })).toHaveCount(0, { timeout: 20_000 });
  await sendReply(page).click();
  await expect(inThread).toHaveCount(0);
  const repliesOf = async () => must(await u.w.owner.client.get(`/api/messages/${root}/replies`), "thread replies").json().messages as { uploads?: { name: string }[] }[];
  await expect.poll(async () => (await repliesOf()).length).toBe(1);
  expect((await repliesOf())[0]!.uploads!.map((x) => x.name)).toEqual(["chart.png", "deploy.log"]);
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
  await expect.poll(async () => (await pageOf(u.w.owner, u.conv)).length).toBe(1); // the server stores the message after the bubble shows
  const posted = await pageOf(u.w.owner, u.conv);
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

// ---- Rule: Pasted files attach like picked ones; pasted text stays text ---------------------------------------------------------
// Owner ruling 2026-10-18: "Inline file paste doesn't work, but it should." Prototype v41 has onPaste on both composers: a paste that holds
// files attaches them and is taken over (preventDefault); a paste of text is left alone.

const FIRST_MESSAGE = "Step 1 is the filter chips UI";
const screenshot = { name: "screenshot.png", type: "image/png", bytes: png(16, 16, true) };

scenario("Pasting a file into the composer attaches it", { tag: ["@browser", "@I-31"] }, async ({ server, page, context }) => {
  // Given conversation 41 is open with a thread on its first message
  const u = await voiceWorld({ server, page, context });
  const root = await ownerSays(u.w.owner, u.conv, FIRST_MESSAGE);
  await openConversation(page, u.w.srv, u.conv);
  await expect(messageLog(page).getByText(FIRST_MESSAGE)).toBeVisible();
  const messageBox = page.getByRole("textbox", { name: /^Message/ });

  // Examples: the message box, message
  // When the owner pastes the image "screenshot.png" into the message box
  expect(await pasteFiles(messageBox, [screenshot]), "the paste of a file is taken over").toBe(true);

  // Then the message box shows "screenshot.png" under "Files to send"
  await expect(filesToSend(page).getByRole("listitem")).toHaveCount(1);
  await expect(filesToSend(page)).toContainText("screenshot.png");

  // And "screenshot.png" is not typed into the message box as text
  await expect(messageBox).toHaveValue("");

  // And sending posts one message with the file
  await expect(page.getByRole("progressbar", { name: /^Uploading / })).toHaveCount(0, { timeout: 20_000 });
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(filesToSend(page)).toHaveCount(0);
  await expect.poll(async () => (await pageOf(u.w.owner, u.conv)).length).toBe(2);
  const sent = (await pageOf(u.w.owner, u.conv)).at(-1)!;
  expect(sent.uploads!.map((x) => x.name)).toEqual(["screenshot.png"]);

  // Examples: the thread's reply box, reply
  // When the owner pastes the image "screenshot.png" into the thread's reply box
  await openThread(page, FIRST_MESSAGE);
  expect(await pasteFiles(replyBox(page), [screenshot]), "the paste of a file is taken over").toBe(true);

  // Then the thread's reply box shows "screenshot.png" under "Files to send"
  const inThread = threadPane(page).getByRole("list", { name: "Files to send" });
  await expect(inThread.getByRole("listitem")).toHaveCount(1);
  await expect(inThread).toContainText("screenshot.png");

  // And "screenshot.png" is not typed into the thread's reply box as text
  await expect(replyBox(page)).toHaveValue("");

  // And sending posts one reply with the file
  await expect(page.getByRole("progressbar", { name: /^Uploading / })).toHaveCount(0, { timeout: 20_000 });
  await sendReply(page).click();
  await expect(inThread).toHaveCount(0);
  // a reply is shown at once and posted after: the pane empties before the server has it
  const repliesOf = async () => must(await u.w.owner.client.get(`/api/messages/${root}/replies`), "thread replies").json().messages as { uploads?: { name: string }[] }[];
  await expect.poll(async () => (await repliesOf()).length).toBe(1);
  const replies = await repliesOf();
  expect(replies).toHaveLength(1);
  expect(replies[0]!.uploads!.map((x) => x.name)).toEqual(["screenshot.png"]);
});

scenario("Pasting text into the composer stays a normal paste", { tag: ["@browser"] }, async ({ server, page, context }) => {
  // Given conversation 41 is open with a thread on its first message
  const u = await voiceWorld({ server, page, context });
  await ownerSays(u.w.owner, u.conv, FIRST_MESSAGE);
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await openConversation(page, u.w.srv, u.conv);
  await expect(messageLog(page).getByText(FIRST_MESSAGE)).toBeVisible();
  await page.evaluate(() => navigator.clipboard.writeText("Looks good to me"));
  const messageBox = page.getByRole("textbox", { name: /^Message/ });

  // When the owner pastes the words "Looks good to me" into the message box and into the thread's reply box
  await messageBox.click();
  await page.keyboard.press("ControlOrMeta+V");
  await openThread(page, FIRST_MESSAGE);
  await replyBox(page).click();
  await page.keyboard.press("ControlOrMeta+V");

  // Then both boxes show "Looks good to me" as text
  await expect(messageBox).toHaveValue("Looks good to me");
  await expect(replyBox(page)).toHaveValue("Looks good to me");

  // And no file waits under "Files to send"
  await expect(filesToSend(page)).toHaveCount(0);
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
  expect(await img.getAttribute("src")).toMatch(/^\/api\/identities\/\d+\/avatar\.svg\?v=[0-9a-f]+$/);
});

scenario("An agent changes its avatar later", { tag: ["@cli", "@browser"] }, async ({ server, page, context }) => {
  // Background
  const u = await voiceWorld({ server, page, context });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "convoz-av-"));

  // Given "devtool" set an SVG avatar of plain shapes
  const old = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="5" fill="#2a7"/></svg>';
  must(await send(u.w.srv.target, "PATCH", "/api/me/profile", { json: { avatar_svg: old }, headers: { Authorization: `Bearer ${u.devtool.lease}` } }), "set avatar");
  await page.goto(`${u.w.srv.origin}/crew`);
  const img = page.locator('img[alt="@devtool avatar"]').first();
  await expect(img).toBeVisible();
  const before = (await img.getAttribute("src"))!;

  // When "convoz profile --set avatar=new.svg" runs as "devtool" with other shapes and a script in it
  const fresh = path.join(dir, "new.svg");
  fs.writeFileSync(fresh, '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><script>alert(1)</script><rect width="10" height="10" fill="#c33"/></svg>');
  const res = await convoz(u.w.box, u.devtool.sid, ["profile", "--set", `avatar=${fresh}`]);
  expect(res.code, res.stderr).toBe(0);

  // And the owner opens Crew
  await page.goto(`${u.w.srv.origin}/crew`);

  // Then the new avatar shows next to "@devtool" at a new URL, so no cached copy of the old one shows
  await expect(img).toBeVisible();
  await expect(img).not.toHaveAttribute("src", before);
  await expect.poll(() => img.evaluate((e: HTMLImageElement) => e.naturalWidth)).toBeGreaterThan(0);
  const served = await page.request.get(u.w.srv.origin + (await img.getAttribute("src"))!);
  const text = await served.text();
  expect(text).toContain("#c33");

  // And the server cleaned it as it cleans an avatar at creation
  expect(text).not.toContain("script");
  expect(served.headers()["content-security-policy"]).toBe("default-src 'none'; sandbox");

  // And "convoz profile --set avatar=photo.png" is refused before anything is sent, because it is not an SVG
  const photo = path.join(dir, "photo.png");
  fs.writeFileSync(photo, png(4, 4, true));
  const refused = await convoz(u.w.box, u.devtool.sid, ["profile", "--set", `avatar=${photo}`]);
  expect(refused.code).toBe(2);
  expect(refused.stderr).toContain("not an SVG");
  const still = await page.request.get(u.w.srv.origin + (await img.getAttribute("src"))!);
  expect(await still.text()).toContain("#c33");
});

scenario("Pending attachments show as previews before send", { tag: ["@browser"] }, async ({ server, page, context }) => {
  // Background
  const u = await voiceWorld({ server, page, context });
  await openConversation(page, u.w.srv, u.conv);

  // Given "chart.png" and "deploy.log" wait under "Files to send"
  await dropFiles(page, [chart, logFile]);
  const list = filesToSend(page);
  await expect(list.getByRole("listitem")).toHaveCount(2);
  await expect(page.getByRole("progressbar", { name: /^Uploading / })).toHaveCount(0, { timeout: 20_000 });

  // Then "chart.png" shows as a 56 px thumbnail and "deploy.log" as a chip with its icon, name and size
  const thumb = list.getByRole("listitem").filter({ hasText: "chart.png" }).locator("img");
  await expect(thumb).toBeVisible();
  await expect.poll(() => thumb.evaluate((e: HTMLImageElement) => e.naturalWidth)).toBeGreaterThan(0);
  await thumb.evaluate((e) => Promise.all(e.closest(".fin")!.getAnimations().map((a) => a.finished)).then(() => undefined)); // the enter animation (finIn) has settled, so the box is not mid-translate
  const t = await thumb.boundingBox();
  expect([t!.width, t!.height]).toEqual([56, 56]);
  const chip = list.getByRole("listitem").filter({ hasText: "deploy.log" });
  const c = await chip.locator(".fchip").boundingBox();
  expect(c!.height).toBe(56);
  await expect(chip).toContainText("2 KB");
  await expect(chip.locator("svg")).toHaveCount(2); // the file icon and the x

  // And each has a remove button
  await expect(page.getByRole("button", { name: "Remove chart.png" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Remove deploy.log" })).toBeVisible();

  // When the owner sends the message
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(list).toHaveCount(0);

  // Then the message shows the image at most 240 px high that opens whole in its own tab
  const shown = messageLog(page).getByRole("img", { name: "chart.png" });
  await expect(shown).toBeVisible();
  await expect.poll(() => shown.evaluate((e: HTMLImageElement) => e.naturalWidth)).toBeGreaterThan(0);
  expect((await shown.boundingBox())!.height).toBeLessThanOrEqual(240);
  const open = messageLog(page).getByRole("link", { name: "View image chart.png" });
  await expect(open).toHaveAttribute("target", "_blank");
  await expect(open).toHaveAttribute("href", /^\/api\/files\//);

  // And "deploy.log" shows as a file card with its icon, name, size and a download link
  const card = messageLog(page).getByRole("link", { name: /deploy\.log/ });
  await expect(card).toContainText("2 KB");
  await expect(card).toHaveAttribute("download", "deploy.log");
  await expect(card.locator("svg")).toHaveCount(2); // the file icon and the download arrow
});
