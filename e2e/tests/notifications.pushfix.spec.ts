import type { BrowserContext, Page } from "@playwright/test";
import { pagePath } from "../../apps/web/src/shared/pagePath.ts";
import { needsHomeScreen, pushSupported } from "../../apps/web/src/features/notifications/support.ts";
import { signInBrowser } from "../lib/machines.ts";
import { installFakePhone } from "../lib/push-phone.ts";
import { ask, decrypt, pushWorld, received, type PushWorld, type Sub } from "../lib/push-wp14.ts";
import { expect, scenario } from "../lib/scenario.ts";

// Turning push on from the phone. The owner: "I'm not getting native notifications - can we fix that?" and "I added it to the Home
// Screen already. I didn't get a notification for notifications being turned on".
// Chromium cannot reach a real push service from a test, so the page gets a PushManager that hands out one subscription to the fake
// push service (a real key pair, so the test can decrypt what the server sends); everything else is the real app and the real server.

const SWITCH = "Push on this device";

async function phoneAllowing(w: PushWorld, page: Page, context: BrowserContext, o: { neverReady?: boolean } = {}): Promise<Sub> {
  const sub = await installFakePhone(context, o);
  await signInBrowser(w.srv, w.owner, page, context);
  await page.route("**/api/push/vapid-key", async (route) => {
    await new Promise((r) => setTimeout(r, 800));
    await route.continue();
  });
  await page.goto(`${w.srv.origin}/settings`);
  await expect(page.getByRole("switch", { name: SWITCH })).toBeVisible();
  return sub;
}

const thisDevice = (page: Page) => page.getByText("This device", { exact: true }).locator("..");

scenario("Turning push on shows each step and ends On", { tag: ["@browser"] }, async ({ server, dataDir, page, context }, info) => {
  info.setTimeout(60_000);
  const w = await pushWorld(server, dataDir);
  // Given the owner's phone allows notifications
  await phoneAllowing(w, page, context);
  await expect(thisDevice(page)).toContainText("Off");
  // When the owner turns on "Push on this device" in Settings
  await page.getByRole("switch", { name: SWITCH }).click();
  // Then Settings says "Asking iPhone for permission…" and then "Signing up this device…"
  await expect(thisDevice(page)).toContainText("Asking iPhone for permission…");
  await expect(thisDevice(page)).toContainText("Signing up this device…");
  // And Settings shows this device as "On"
  await expect(page.getByRole("switch", { name: SWITCH })).toBeChecked();
  await expect(thisDevice(page)).toHaveText(/On$/);
});

scenario("Turning push on sends a confirmation push", { tag: ["@browser"] }, async ({ server, dataDir, page, context }, info) => {
  info.setTimeout(60_000);
  const w = await pushWorld(server, dataDir);
  const sub = await phoneAllowing(w, page, context);
  const mine = async () => (await received(w.srv)).filter((r) => r.endpoint === sub.endpoint);
  // When the owner turns on "Push on this device" in Settings
  await page.getByRole("switch", { name: SWITCH }).click();
  // Then the fake push service receives one push titled "Notifications are on"
  await expect.poll(async () => (await mine()).length, { timeout: 15_000 }).toBe(1);
  const shown = decrypt(sub, (await mine())[0]!);
  expect(shown.title).toBe("Notifications are on");
  // And the push reads "You'll get messages from your agents here."
  expect(shown.body).toBe("You'll get messages from your agents here.");
});

scenario("A background worker that never starts shows an error", { tag: ["@browser"] }, async ({ server, dataDir, page, context }, info) => {
  info.setTimeout(60_000);
  const w = await pushWorld(server, dataDir);
  // Given the owner's phone allows notifications / And the app's background worker never becomes ready
  const sub = await phoneAllowing(w, page, context, { neverReady: true });
  // When the owner turns on "Push on this device" in Settings
  await page.getByRole("switch", { name: SWITCH }).click();
  // Then Settings shows an error saying the background worker did not start
  await expect(page.getByRole("alert")).toContainText("Starting the background worker failed: The app's background worker did not start within 10 seconds", { timeout: 20_000 });
  // And this device is not signed up for push
  await expect(page.getByRole("switch", { name: SWITCH })).not.toBeChecked();
  const subs = (await (await page.request.get(`${w.srv.origin}/api/push/subscriptions`)).json()).subscriptions as { current: boolean }[];
  expect(subs.filter((s) => s.current)).toHaveLength(0);
  expect((await received(w.srv)).filter((r) => r.endpoint === sub.endpoint)).toHaveLength(0);
});

scenario("A browser with push only on its background worker can turn push on", { tag: ["@api"] }, () => {
  // Given a phone browser whose window has no push support but whose background worker has it
  const iphone = { serviceWorker: {}, userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148" };
  const registrationOnly = { navigator: iphone, window: { Notification: {} }, ServiceWorkerRegistration: { prototype: { pushManager: {} } } };
  // Then Settings treats the phone as able to receive push
  expect(pushSupported(registrationOnly)).toBe(true);
  expect(needsHomeScreen(registrationOnly)).toBe(false);
  // control: a Safari tab with no push anywhere still needs the Home Screen
  const tab = { navigator: iphone, window: { Notification: {} }, ServiceWorkerRegistration: { prototype: {} } };
  expect(pushSupported(tab)).toBe(false);
  expect(needsHomeScreen(tab)).toBe(true);
});

// Owner (Drew, msg 144): "This is when I clicked on the notification". A real notification tap cannot be driven in Playwright, so
// this opens what the tap opens: the URL the server put in the ask's push, through the worker's own pagePath.
scenario("Tapping an ask push opens Now, not Conversation not found", { tag: ["@browser"] }, async ({ server, dataDir, page, context }, info) => {
  info.setTimeout(60_000);
  const w = await pushWorld(server, dataDir);
  // Given "devtool" asks a question and the owner's phone gets a push for it
  await ask(w);
  await expect.poll(async () => (await received(w.srv)).length, { timeout: 15_000 }).toBeGreaterThan(0);
  const shown = decrypt(w.sub, (await received(w.srv))[0]!);
  expect(shown.reason).toBe("ask");
  // When the owner taps the notification
  await signInBrowser(w.srv, w.owner, page, context);
  await page.goto(`${w.srv.origin}${pagePath(shown.url)}`);
  // Then the Now screen opens
  await expect(page.getByRole("heading", { name: "Now", exact: true })).toBeVisible();
  // And it does not say "Conversation not found"
  await expect(page.getByRole("heading", { name: "Conversation not found" })).toHaveCount(0);
});

scenario("A pushed URL that is not a page of the app opens Now", { tag: ["@api"] }, () => {
  // Given a notification that carries a URL the app has no page for, or another site
  // When the owner taps it
  // Then the worker opens "/"
  for (const bad of ["/now", "/nowhere", "//evil.example/", "https://evil.example/", "/\\evil.example", undefined]) expect(pagePath(bad), String(bad)).toBe("/");
  // And a page of the app opens as pushed
  for (const good of ["/", "/chats/41", "/settings", "/settings/privacy", "/now/machine/7", "/chats/41#reply=3"]) expect(pagePath(good), good).toBe(good);
});
