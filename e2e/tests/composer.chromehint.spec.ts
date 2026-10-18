import { installFakeBrowser, type FakeBrowser } from "../lib/chrome-ios.ts";
import { openConversation, recordButton, voiceWorld } from "../lib/ui-wp10.ts";
import { expect, scenario } from "../lib/scenario.ts";
import type { BrowserContext, Page } from "@playwright/test";
import type { ServerHandle, ServerOptions } from "../lib/fixtures.ts";

// The owner (Drew, ask 119): "Chrome". The microphone note says why the microphone is not available.

type Fx = { server: (o?: ServerOptions) => Promise<ServerHandle>; page: Page; context: BrowserContext };

/** The owner taps the microphone in a browser like `browser` and the note under the composer is returned. */
async function tapMic({ server, page, context }: Fx, browser: FakeBrowser) {
  const u = await voiceWorld({ server, page, context });
  await installFakeBrowser(context, browser);
  await openConversation(page, u.w.srv, u.conv);
  await recordButton(page).click();
  return page.getByRole("alert").filter({ hasText: /microphone|record audio/i });
}

scenario("Chrome on iPhone without a microphone API is told to use Safari", { tag: ["@browser"] }, async ({ server, page, context }, info) => {
  info.setTimeout(90_000);
  const note = await tapMic({ server, page, context }, { chromeIos: true, noRecorderApi: true });
  await expect(note).toHaveText("Chrome on iPhone can't use the microphone here. Open Convoz in Safari and add it to the Home Screen from there.");
});

scenario("Another browser without a microphone API says it cannot record", { tag: ["@browser"] }, async ({ server, page, context }, info) => {
  info.setTimeout(90_000);
  const note = await tapMic({ server, page, context }, { noRecorderApi: true });
  await expect(note).toHaveText("This browser can't record audio.");
});

scenario("A refused microphone says access is off", { tag: ["@browser"] }, async ({ server, page, context }, info) => {
  info.setTimeout(90_000);
  const note = await tapMic({ server, page, context }, { micDenied: true });
  await expect(note).toHaveText("Microphone access is off. Allow it in Settings for this app, then try again.");
});
