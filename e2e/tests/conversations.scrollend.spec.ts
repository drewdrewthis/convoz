import fs from "node:fs";
import type { Locator, Page } from "@playwright/test";
import { agentAsks } from "../lib/asks.ts";
import { agentPost, createConversation, ownerSays } from "../lib/chat.ts";
import { chatRow, composer, fromBottom, message, messageLog, streamOpen, uiWorld, type UiWorld } from "../lib/chat-ui.ts";
import { expect, scenario } from "../lib/scenario.ts";
import { png, postWith, uploadWhole } from "../lib/uploads-wp10.ts";

const LAST = "msg-200";
const para = (n: number) => `Paragraph ${n}: ${"the quick brown fox jumps over the lazy dog and keeps on running ".repeat(6)}`;
const jumpButton = (page: Page): Locator => page.getByRole("button", { name: "Jump to latest" });
const shots = "/tmp/convoz-scrollend-shots";

/** Conversation 41 with `count` text-heavy messages: long markdown with code from the agent, long and short lines, images and asks. */
async function longConversation(u: UiWorld, count: number, advance: (ms: number) => Promise<void>, ids: Record<string, number> = {}): Promise<number> {
  const conv = await createConversation(u.w.owner, { participants: ["devtool"], title: "Ship search filters" });
  const lease = u.sessions.devtool!.lease;
  for (let n = 1; n <= count; n++) {
    const tag = `msg-${String(n).padStart(3, "0")}`;
    if (n % 25 === 0) {
      const up = await uploadWhole({ srv: u.w.srv, owner: u.w.owner }, conv, "image", `chart-${n}.png`, png(300, 200, true));
      await postWith({ srv: u.w.srv, owner: u.w.owner }, conv, `${tag} a chart`, [up.id]);
    } else if (n % 40 === 0 && n < count) {
      await agentAsks(u.w.srv, lease, conv, {});
    } else if (n % 2 === 0) {
      const body = `${tag} ## Report ${n}\n\n${para(n)}\n\n- one\n- two\n- three\n\n\`\`\`go\nfunc main() {\n  fmt.Println("hello")\n}\n\`\`\`\n\n${para(n + 1)}\n\n${para(n + 2)}`;
      let res = await agentPost(u.w.srv, lease, conv, body, { format: "markdown" });
      if (res.status === 429) {
        // the server limits an agent's posting rate: move its clock past the window
        await advance(Number(res.headers["retry-after"] ?? 30) * 1000 + 1000);
        res = await agentPost(u.w.srv, lease, conv, body, { format: "markdown" });
      }
      if (res.status !== 201) throw new Error(`agent post ${n}: ${res.status} ${res.text}`);
    } else {
      ids[tag] = await ownerSays(u.w.owner, conv, `${tag} ${"words ".repeat(n % 7 === 0 ? 80 : 12)}`);
    }
  }
  return conv;
}

/** The newest message is in view and the log is at its bottom edge. */
async function atNewest(page: Page): Promise<void> {
  await expect(message(page, LAST)).toBeInViewport();
  await expect.poll(() => fromBottom(messageLog(page))).toBeLessThanOrEqual(2);
}

/** The page has finished loading and the log has not moved off the newest message for a while (late rows, images, fonts). */
async function staysAtNewest(page: Page): Promise<void> {
  await streamOpen(page);
  await expect(messageLog(page)).toHaveAttribute("data-opened", "true");
  await atNewest(page);
  await page.waitForTimeout(1500);
  expect(await fromBottom(messageLog(page))).toBeLessThanOrEqual(2);
}

const scrollUp = (page: Page, screens: number) => messageLog(page).evaluate((e, n) => (e.scrollTop = Math.max(0, e.scrollTop - n * e.clientHeight)), screens);

// Owner (Drew, msg 253): "We just had to scroll really far for this conversation. There's a lot of text. I guess you should try to scroll to the bottom initially by itself."
scenario("A long conversation opens at the newest message", { tag: ["@browser"] }, async ({ server, testApi, page, context }, info) => {
  info.setTimeout(240_000);
  // Given conversation 41 holds 200 long messages with code, images and asks
  const u = await uiWorld({ server, page, context });
  const conv = await longConversation(u, 200, (ms) => testApi(u.w.srv).advanceClock(ms));

  // When the owner opens conversation 41 from the Conversations list
  await page.goto(`${u.w.srv.origin}/chats`);
  await chatRow(page, "Ship search filters").getByRole("link").click();

  // Then the newest message is in view and stays there
  await staysAtNewest(page);

  // When the owner reloads the page
  await page.reload();

  // Then the newest message is in view and stays there
  await staysAtNewest(page);

  // When the owner goes back to the list and forward again
  await page.goBack();
  await expect(chatRow(page, "Ship search filters")).toBeVisible();
  await page.goForward();

  // Then the newest message is in view and stays there
  await staysAtNewest(page);

  // When the owner opens conversation 41 on a slow network
  await page.goto(`${u.w.srv.origin}/chats`);
  await page.route(/\/api\/(conversations\/\d+\/messages|files\/)/, async (route) => {
    await new Promise((done) => setTimeout(done, 1200));
    await route.continue();
  });
  await chatRow(page, "Ship search filters").getByRole("link").click();

  // Then the newest message is in view and stays there
  await staysAtNewest(page);
  expect(conv).toBeGreaterThan(0);
});

// Owner (Drew, msg 253): "We just had to scroll really far for this conversation."
scenario("A link to a message in a long conversation still opens at that message", { tag: ["@browser"] }, async ({ server, testApi, page, context }, info) => {
  info.setTimeout(240_000);
  // Given conversation 41 holds 200 long messages with code, images and asks
  const u = await uiWorld({ server, page, context });
  const ids: Record<string, number> = {};
  const conv = await longConversation(u, 200, (ms) => testApi(u.w.srv).advanceClock(ms), ids);

  // When the owner opens the link to "msg-101"
  await page.goto(`${u.w.srv.origin}/chats/${conv}#m${ids["msg-101"]}`);

  // Then "msg-101" is in view and the log is not at the newest message
  await expect(message(page, "msg-101")).toBeInViewport({ timeout: 10_000 });
  await page.waitForTimeout(1500);
  await expect(message(page, "msg-101")).toBeInViewport();
  expect(await fromBottom(messageLog(page))).toBeGreaterThan(500);
});

// Owner (Drew, msg 253): "maybe a little button hovers to scroll to the bottom automatically. Just make it easier."
scenario("A Jump to latest button shows when the owner scrolls up and takes them to the newest message", { tag: ["@browser"] }, async ({ server, testApi, page, context }, info) => {
  info.setTimeout(240_000);
  // Given conversation 41 holds 200 long messages with code, images and asks
  const u = await uiWorld({ server, page, context });
  const conv = await longConversation(u, 200, (ms) => testApi(u.w.srv).advanceClock(ms));

  // And the owner has conversation 41 open at its newest message
  await page.goto(`${u.w.srv.origin}/chats/${conv}`);
  await staysAtNewest(page);

  // Then no Jump to latest button shows
  await expect(jumpButton(page)).toHaveCount(0);

  // When the owner scrolls up two screens
  await scrollUp(page, 2);

  // Then a round Jump to latest button floats above the composer and covers neither the composer nor the log's last line
  await expect(jumpButton(page)).toBeVisible();
  const btn = (await jumpButton(page).boundingBox())!;
  const box = (await composer(page).boundingBox())!;
  const logBox = (await messageLog(page).boundingBox())!;
  expect(btn.y + btn.height).toBeLessThanOrEqual(box.y);
  expect(btn.y + btn.height).toBeLessThanOrEqual(logBox.y + logBox.height);
  expect(btn.x + btn.width).toBeLessThanOrEqual((page.viewportSize()?.width ?? 0));
  expect(Math.abs(btn.width - btn.height)).toBeLessThanOrEqual(1);

  // And it reads clearly in the dark and the light look
  fs.mkdirSync(shots, { recursive: true });
  for (const scheme of ["dark", "light"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    expect(await contrast(jumpButton(page))).toBeGreaterThanOrEqual(4.5);
    await page.screenshot({ path: `${shots}/jump-${info.project.name}-${scheme}.png` });
  }

  // When the owner taps the button
  await jumpButton(page).click();

  // Then the newest message is in view and the button is gone
  await atNewest(page);
  await expect(jumpButton(page)).toHaveCount(0);

  // When the owner scrolls up two screens and "devtool" posts "Fresh news" in conversation 41
  await scrollUp(page, 2);
  await expect(jumpButton(page)).toBeVisible();
  const posted = await agentPost(u.w.srv, u.sessions.devtool!.lease, conv, "Fresh news");
  expect(posted.status).toBe(201);

  // Then the one button reads "New message ↓" with the count and no second control shows
  const pill = page.getByRole("button", { name: "New message ↓" });
  await expect(pill).toBeVisible({ timeout: 3_000 });
  await expect(pill).toHaveText("↓ 1 new");
  await expect(jumpButton(page)).toHaveCount(0);
  await expect(page.locator("#pill")).toHaveCount(1);

  // When the owner taps it
  await pill.click();

  // Then "Fresh news" is in view and the button is gone
  await expect(message(page, "Fresh news")).toBeInViewport();
  await expect(page.locator("#pill")).toBeHidden();
});

/** Contrast ratio between a button's text and its background colour. */
async function contrast(l: Locator): Promise<number> {
  return l.evaluate((e) => {
    const rgb = (c: string) => {
      const cv = document.createElement("canvas");
      cv.width = cv.height = 1;
      const g = cv.getContext("2d")!;
      g.fillStyle = c;
      g.fillRect(0, 0, 1, 1);
      return Array.from(g.getImageData(0, 0, 1, 1).data.slice(0, 3));
    };
    const lum = ([r, g, b]: number[]) => {
      const f = (v: number) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
      return 0.2126 * f(r!) + 0.7152 * f(g!) + 0.0722 * f(b!);
    };
    const s = getComputedStyle(e);
    const [a, b] = [lum(rgb(s.color)), lum(rgb(s.backgroundColor))];
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  });
}
