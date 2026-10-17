import fs from "node:fs";
import path from "node:path";
import { appCard, appsWorld, openConversation as openApps, png as pixel, requestLog, stored, validApp, postApp } from "../lib/apps-wp11.ts";
import { agentPost } from "../lib/chat.ts";
import { signInWith } from "../lib/mobile.ts";
import { must } from "../lib/owner.ts";
import { pageOf } from "../lib/messages-wp4.ts";
import { expect, scenario } from "../lib/scenario.ts";
import { github, serve, settledCard } from "../lib/unfurl-wp15.ts";
import { openConversation, voiceMessages, voiceWorld } from "../lib/ui-wp10.ts";
import { headUpload, postWith, png, raw, scratch, uploadWhole, wav } from "../lib/uploads-wp10.ts";
import { pageLink } from "../lib/wp17.ts";

// Bindings of poor-network.feature that waited for the upload code (WP10) and for media that holds back (design §12.3).
// The lossy profile is the one of lib/wp17.ts: 400 ms round trip, 400 kbps.

const PR = "https://github.com/acme/app/pull/415";
const MEDIA_ROUTES = /\/api\/files\/|\/api\/messages\/\d+\/(unfurl|app)\b|\/api\/apps\/\d+\/frame/;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

scenario("A voice note upload cut halfway resumes", { tag: ["@browser", "@lossy"] }, async ({ server, page, context, browser }, info) => {
  info.setTimeout(420_000); // 5 MB at 400 kbps is 100 seconds of upload, and the second half comes after the cut
  const u = await voiceWorld({ server, page, context });
  await openConversation(page, u.w.srv, u.conv);
  const owner = { srv: u.w.srv, owner: u.w.owner };
  const patches: { at: number; offset: number }[] = [];
  const heads: number[] = [];
  page.on("request", (r) => {
    if (r.method() === "PATCH" && r.url().includes("/api/uploads/")) patches.push({ at: Date.now(), offset: Number(r.headers()["upload-offset"]) });
    if (r.method() === "HEAD" && r.url().includes("/api/uploads/")) heads.push(Date.now());
  });

  // Given the owner records a 5 MB voice note on the lossy profile
  const file = path.join(scratch(), "voice-note.wav");
  fs.writeFileSync(file, wav(119, 22050)); // 5.2 MB
  const total = fs.statSync(file).size;
  const link = await pageLink(context, page, { lossy: true });
  await link(false);
  const created = page.waitForResponse((r) => r.url().endsWith("/api/uploads") && r.request().method() === "POST", { timeout: 60_000 });
  await page.locator('input[type="file"]').setInputFiles(file);
  const id = (await (await created).json()).id as string;

  // When the connection drops at about 50% of the upload
  await expect
    .poll(async () => Number((await headUpload(owner, id)).headers["upload-offset"]), { timeout: 150_000, intervals: [500] })
    .toBeGreaterThanOrEqual(total * 0.5);
  expect(Number((await headUpload(owner, id)).headers["upload-offset"])).toBeLessThan(total);
  const droppedAt = Date.now();
  await link(true);
  await wait(1_500);
  await link(false);

  // Then the upload resumes from the server's committed offset, which is above 0
  await expect(page.getByRole("progressbar", { name: /^Uploading / })).toHaveCount(0, { timeout: 240_000 });
  const resumed = patches.filter((p) => p.at > droppedAt);
  expect(resumed.length).toBeGreaterThan(0);
  expect(resumed[0]!.offset).toBeGreaterThan(0);
  expect(heads.some((h) => h > droppedAt)).toBe(true);
  expect(patches.some((p) => p.at > droppedAt && p.offset === 0)).toBe(false);
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(voiceMessages(page)).toHaveCount(1, { timeout: 60_000 });

  // And the voice note plays in a second browser
  const ctx2 = await browser.newContext();
  try {
    const page2 = await ctx2.newPage();
    await signInWith(u.w.srv, u.second, page2, ctx2);
    await openConversation(page2, u.w.srv, u.conv);
    const note = voiceMessages(page2).first();
    await note.getByRole("button", { name: "Play voice message" }).click();
    await expect.poll(() => note.locator("audio").evaluate((a: HTMLAudioElement) => !a.paused && a.currentTime > 0.3), { timeout: 30_000 }).toBe(true);
    const sent = (await pageOf(u.w.owner, u.conv))[0]!.uploads![0]!;
    expect((await raw(owner, "GET", `/api/files/${sent.id}`)).body.length).toBe(total);
  } finally {
    await ctx2.close();
  }
});

scenario("With Save-Data on, no media loads until tapped", { tag: ["@browser", "@lossy"] }, async ({ server, page, context }, info) => {
  info.setTimeout(60_000);
  // Given the browser reports Save-Data on
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "connection", { value: { saveData: true, effectiveType: "4g", addEventListener() {}, removeEventListener() {} }, configurable: true });
  });
  const a = await appsWorld({ server, page, context, browser: true });
  const who = { srv: a.w.srv, owner: a.w.owner };
  const gh = await github();
  try {
    // And a conversation with 3 images, an unfurl card and an app preview
    const images = [];
    for (const [name, side] of [["one.png", 20], ["two.png", 40], ["three.png", 60]] as const) images.push({ name, id: (await uploadWhole(who, a.conv, "image", name, png(side, side, true))).id });
    must(await postWith(who, a.conv, "Three pictures", images.map((i) => i.id)), "three images", 201);
    await serve(a.w.srv, gh, "github.com", "api.github.com");
    const link = Number(must(await agentPost(a.w.srv, a.devtool.lease, a.conv, PR), "post the link", 201).json().id);
    expect((await settledCard(a.w.owner, link)).status, "the server has the card, so the page's silence is its own").toBe("ok");
    const first = await stored(a.w.srv, a.devtool.lease, pixel(200, 40, 40), "image");
    const second = await stored(a.w.srv, a.devtool.lease, pixel(40, 200, 40), "image");
    const gallery = validApp("gallery-compare");
    gallery.props.images[0].upload = first.upload;
    gallery.props.images[1].upload = second.upload;
    await postApp(a, gallery, "The gallery");
    const requests = requestLog(page);

    // When the owner opens a conversation with 3 images, an unfurl card and an app preview
    await openApps(page, a.w.srv, a.conv);

    // Then the network log shows 0 image, unfurl or app-preview requests
    // And each placeholder shows its size and "tap to load"
    for (const i of images) await expect(page.getByRole("button", { name: new RegExp(`${i.name} \\d+ (B|KB) · tap to load`) })).toBeVisible();
    await expect(page.getByRole("button", { name: "Preview · tap to load" })).toBeVisible();
    await expect(appCard(page, "Search bar, before and after")).toContainText(/tap to load · \d+(\.\d+)? ?(KB|B|MB)/i);
    await wait(1_000);
    expect(requests.filter((r) => MEDIA_ROUTES.test(r))).toEqual([]);

    // And tapping one image loads only that image
    await page.getByRole("button", { name: /two\.png/ }).click();
    await expect(page.getByRole("img", { name: "two.png" })).toBeVisible();
    await expect.poll(() => requests.filter((r) => MEDIA_ROUTES.test(r))).toEqual([expect.stringContaining(`/api/files/${images[1]!.id}`)]);
    await expect(page.getByRole("button", { name: /one\.png.*tap to load/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /three\.png.*tap to load/ })).toBeVisible();
  } finally {
    await gh.close();
  }
});
