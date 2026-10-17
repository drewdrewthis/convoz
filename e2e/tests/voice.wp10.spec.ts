import fs from "node:fs";
import path from "node:path";
import { convoz } from "../lib/chat.ts";
import { messageLog } from "../lib/chat-ui.ts";
import { send } from "../lib/http.ts";
import { signInWith } from "../lib/mobile.ts";
import { must } from "../lib/owner.ts";
import { pageOf } from "../lib/messages-wp4.ts";
import { expect, scenario, test } from "../lib/scenario.ts";
import { openConversation, recordButton, recording, voiceMessages, voiceWorld, type VoiceWorld } from "../lib/ui-wp10.ts";
import { headUpload, postWith, raw, scratch, setEngine, uploadWhole, wav, type Actor } from "../lib/uploads-wp10.ts";

/*
 * VOICE NOTES (WP10): specs/features/voice.feature. The browser has a fake microphone that plays a fixture recording (chromium's
 * --use-file-for-fake-audio-capture); the page contract is the block atop lib/ui-wp10.ts.
 */

const mic = path.join(scratch(), "fixture-recording.wav");
fs.writeFileSync(mic, wav(60));
test.use({ launchOptions: { args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", `--use-file-for-fake-audio-capture=${mic}`] } });

const owner = (u: VoiceWorld): Actor => ({ srv: u.w.srv, owner: u.w.owner });
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Click the mic and return the public id of the upload the recording starts. */
async function startRecording(page: import("@playwright/test").Page): Promise<string> {
  const created = page.waitForResponse((r) => r.url().endsWith("/api/uploads") && r.request().method() === "POST", { timeout: 15_000 });
  await recordButton(page).click();
  await expect(recording(page)).toBeVisible();
  return (await (await created).json()).id as string;
}

/** The owner records for `ms` and sends. */
async function recordAndSend(page: import("@playwright/test").Page, ms: number): Promise<void> {
  await startRecording(page);
  await wait(ms);
  await page.getByRole("button", { name: "Send voice message" }).click();
}

/** A voice note the owner sent by the API (a Given that is not the point of the scenario). */
async function sentNote(u: VoiceWorld, seconds = 10, rate = 16000): Promise<string> {
  const up = await uploadWhole(owner(u), u.conv, "audio", "voice-note.wav", wav(seconds, rate), 600_000, { "Upload-Duration-Ms": String(seconds * 1000) });
  must(await postWith(owner(u), u.conv, "", [up.id]), "voice message", 201);
  return up.id;
}

scenario("A voice note uploads while it records", { tag: ["@browser"] }, async ({ server, page, context }, info) => {
  info.setTimeout(90_000);
  // Background
  const u = await voiceWorld({ server, page, context });
  await openConversation(page, u.w.srv, u.conv);

  // When the owner records for 20 seconds
  const id = await startRecording(page);
  await wait(3_000);
  const early = Number((await headUpload(owner(u), id)).headers["upload-offset"]);
  await wait(7_000);
  const later = Number((await headUpload(owner(u), id)).headers["upload-offset"]);

  // Then the server's upload offset grows before the recording stops
  await expect(recording(page)).toBeVisible();
  expect(early).toBeGreaterThan(0);
  expect(later).toBeGreaterThan(early);

  // And sending posts one voice message with a 0:20 duration
  await expect(recording(page)).toContainText("0:20", { timeout: 30_000 }); // the recorder's own clock, so a slow phone cannot skew it
  await page.getByRole("button", { name: "Send voice message" }).click();
  await expect(voiceMessages(page)).toHaveCount(1);
  await expect(voiceMessages(page).first().getByText("0:20", { exact: true })).toBeVisible();
  const posted = await pageOf(u.w.owner, u.conv);
  expect(posted).toHaveLength(1);
  expect(posted[0]!.uploads).toHaveLength(1);
  expect(posted[0]!.uploads![0]).toMatchObject({ kind: "audio", inline: true });
  expect(posted[0]!.uploads![0]!.duration_ms).toBeGreaterThanOrEqual(20_000);
  expect(posted[0]!.uploads![0]!.duration_ms).toBeLessThan(21_000);
});

scenario("Cancelling a recording sends nothing", { tag: ["@browser"] }, async ({ server, page, context, testApi }, info) => {
  info.setTimeout(60_000);
  // Background
  const u = await voiceWorld({ server, page, context });
  await openConversation(page, u.w.srv, u.conv);

  // When the owner records for 5 seconds and cancels
  const id = await startRecording(page);
  await wait(5_000);
  await page.getByRole("button", { name: "Cancel recording" }).click();

  // Then conversation 41 shows no new message
  await expect(recording(page)).toHaveCount(0);
  await expect(messageLog(page).getByRole("article")).toHaveCount(0);
  expect(await pageOf(u.w.owner, u.conv)).toHaveLength(0);
  expect((await headUpload(owner(u), id)).status).toBe(200); // the partial upload is still there ...

  // And the partial upload is gone after 24 hours
  await testApi(u.w.srv).advanceClock(25 * 3_600_000);
  must(await send(u.w.srv.target, "POST", "/__test/maintenance", { json: {} }), "nightly maintenance");
  expect((await headUpload(owner(u), id)).status).toBe(404);
});

scenario("A voice note plays back", { tag: ["@browser"] }, async ({ server, page, context }) => {
  // Background
  const u = await voiceWorld({ server, page, context });

  // Given the owner sent a voice note
  await sentNote(u, 12);
  await openConversation(page, u.w.srv, u.conv);
  const note = voiceMessages(page).first();
  await expect(note.getByText("0:12", { exact: true })).toBeVisible();

  // When the owner taps play
  await note.getByRole("button", { name: "Play voice message" }).click();

  // Then the audio plays and the waveform shows progress
  const audio = note.locator("audio");
  await expect.poll(() => audio.evaluate((a: HTMLAudioElement) => !a.paused && a.currentTime > 0.3), { timeout: 10_000 }).toBe(true);
  await expect(note.getByRole("button", { name: "Pause voice message" })).toBeVisible();
  await expect.poll(async () => Number(await note.getByRole("progressbar", { name: "Playback progress" }).getAttribute("aria-valuenow"))).toBeGreaterThan(0);
});

scenario("A voice note upload resumes after a drop", { tag: ["@browser", "@lossy"] }, async ({ server, page, context, browser }, info) => {
  info.setTimeout(120_000);
  // Background
  const u = await voiceWorld({ server, page, context });
  await openConversation(page, u.w.srv, u.conv);
  const patches: { at: number; offset: number }[] = [];
  const heads: number[] = [];
  page.on("request", (r) => {
    if (r.method() === "PATCH" && r.url().includes("/api/uploads/")) patches.push({ at: Date.now(), offset: Number(r.headers()["upload-offset"]) });
    if (r.method() === "HEAD" && r.url().includes("/api/uploads/")) heads.push(Date.now());
  });

  // Given the network drops during the upload of a 5 MB voice note at about 50%
  const file = path.join(scratch(), "voice-note.wav");
  fs.writeFileSync(file, wav(119, 22050)); // 5.2 MB
  const cdp = await context.newCDPSession(page);
  await cdp.send("Network.enable");
  const conditions = (offline: boolean) => ({ offline, latency: 0, downloadThroughput: -1, uploadThroughput: 700_000 });
  await cdp.send("Network.emulateNetworkConditions", conditions(false));
  const created = page.waitForResponse((r) => r.url().endsWith("/api/uploads") && r.request().method() === "POST", { timeout: 15_000 });
  await page.locator('input[type="file"]').setInputFiles(file);
  const id = (await (await created).json()).id as string;
  const total = fs.statSync(file).size;
  let at = 0;
  for (let i = 0; i < 300 && at < total * 0.5; i++) {
    await wait(100);
    at = Number((await headUpload(owner(u), id)).headers["upload-offset"]);
  }
  expect(at).toBeGreaterThanOrEqual(total * 0.5);
  expect(at).toBeLessThan(total);
  const droppedAt = Date.now();
  await cdp.send("Network.emulateNetworkConditions", conditions(true));
  await wait(1_500);
  await cdp.send("Network.emulateNetworkConditions", conditions(false));

  // When the network returns
  await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await expect(page.getByRole("progressbar", { name: /^Uploading / })).toHaveCount(0, { timeout: 60_000 });

  // Then the upload continues from the committed offset, which is above 0
  const resumed = patches.filter((p) => p.at > droppedAt);
  expect(resumed.length).toBeGreaterThan(0);
  expect(resumed[0]!.offset).toBeGreaterThan(0);
  expect(heads.some((h) => h > droppedAt)).toBe(true);
  expect(patches.some((p) => p.at > droppedAt && p.offset === 0)).toBe(false);
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(voiceMessages(page)).toHaveCount(1);

  // And the voice note plays on a second browser
  const ctx2 = await browser.newContext();
  try {
    const page2 = await ctx2.newPage();
    await signInWith(u.w.srv, u.second, page2, ctx2);
    await openConversation(page2, u.w.srv, u.conv);
    const note = voiceMessages(page2).first();
    await note.getByRole("button", { name: "Play voice message" }).click();
    await expect.poll(() => note.locator("audio").evaluate((a: HTMLAudioElement) => !a.paused && a.currentTime > 0.3), { timeout: 15_000 }).toBe(true);
    const bytes = await raw(owner(u), "GET", `/api/files/${(await pageOf(u.w.owner, u.conv))[0]!.uploads![0]!.id}`);
    expect(bytes.body.length).toBe(total);
  } finally {
    await ctx2.close();
  }
});

scenario("A transcript appears when transcription is on", { tag: ["@browser", "@cli"] }, async ({ server, page, context }, info) => {
  info.setTimeout(60_000);
  // Background
  const u = await voiceWorld({ server, page, context });
  await openConversation(page, u.w.srv, u.conv);

  // Given the workspace transcription engine is set
  await setEngine(owner(u) as { srv: typeof u.w.srv; owner: typeof u.w.owner }, "fake", "ship the filters on Thursday");

  // When the owner sends a voice note that says "ship the filters on Thursday"
  await recordAndSend(page, 2_500);

  // Then the voice message shows the transcript
  const note = voiceMessages(page).first();
  await note.getByRole("button", { name: "Transcript" }).click();
  await expect(note.getByText("ship the filters on Thursday")).toBeVisible();

  // And "devtool" reads the transcript with "convoz read 41"
  const read = await convoz(u.w.box, u.devtool.sid, ["read", String(u.conv)]);
  expect(read.stdout).toContain("ship the filters on Thursday");
});

scenario("With no transcription engine the note has no transcript", { tag: ["@browser"] }, async ({ server, page, context }, info) => {
  info.setTimeout(60_000);
  // Background
  const u = await voiceWorld({ server, page, context });
  await openConversation(page, u.w.srv, u.conv);

  // Given the workspace transcription engine is "none"
  const settings = must(await u.w.owner.client.get("/api/settings"), "settings").json().settings as { key: string; value: unknown }[];
  expect(settings.find((s) => s.key === "transcription.engine")?.value).toBe("none");

  // When the owner sends a voice note
  await recordAndSend(page, 2_500);

  // Then the voice message shows no transcript and no error
  await expect(voiceMessages(page)).toHaveCount(1);
  await wait(2_500);
  await expect(voiceMessages(page).first().getByRole("button", { name: "Transcript" })).toHaveCount(0);
  await expect(page.getByRole("alert").filter({ hasText: /\S/ })).toHaveCount(0);
  const note = (await pageOf(u.w.owner, u.conv))[0]!.uploads![0]!;
  expect(note.transcript).toBeUndefined();
});

scenario("Search finds words that are only in the transcript", { tag: ["@browser", "@cli"] }, async ({ server, page, context }) => {
  // Background
  const u = await voiceWorld({ server, page, context });
  await openConversation(page, u.w.srv, u.conv);

  // Given the owner sent a voice note that says "ZQX-thursday-filters"
  await setEngine(owner(u) as { srv: typeof u.w.srv; owner: typeof u.w.owner }, "fake", "ZQX-thursday-filters");
  await sentNote(u, 3);

  // When the transcript is done
  await expect.poll(async () => (await pageOf(u.w.owner, u.conv)).at(-1)?.uploads?.[0]?.transcript?.state, { timeout: 15_000 }).toBe("done");

  // Then the owner's search for "ZQX-thursday-filters" finds the voice message
  await page.goto(`${u.w.srv.origin}/chats`);
  await page.getByRole("button", { name: "Search", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Search" });
  await dialog.getByRole("combobox", { name: "Search" }).fill("ZQX-thursday-filters");
  const hit = dialog.getByRole("group", { name: "Messages" }).getByRole("option");
  await expect(hit).toHaveCount(1);
  await expect(hit.first()).toContainText("ZQX-thursday-filters");

  // And "convoz search ZQX-thursday-filters" as "devtool" finds it too
  const found = await convoz(u.w.box, u.devtool.sid, ["search", "ZQX-thursday-filters"]);
  expect(found.stdout).toContain("ZQX-thursday-filters");
});
