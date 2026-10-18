import type { BrowserContext, Page } from "@playwright/test";
import { needsHomeScreen, pushSupported } from "../../apps/web/src/features/notifications/support.ts";
import { signInBrowser } from "../lib/machines.ts";
import { decrypt, newSub, pushWorld, received, subBody, type PushWorld, type Sub } from "../lib/push-wp14.ts";
import { expect, scenario } from "../lib/scenario.ts";

// Turning push on from the phone. The owner: "I'm not getting native notifications - can we fix that?" and "I added it to the Home
// Screen already. I didn't get a notification for notifications being turned on".
// Chromium cannot reach a real push service from a test, so the page gets a PushManager that hands out one subscription to the fake
// push service (a real key pair, so the test can decrypt what the server sends); everything else is the real app and the real server.

const SWITCH = "Push on this device";

interface Fake {
  endpoint: string;
  p256dh: string;
  auth: string;
  neverReady: boolean;
}

async function phoneAllowing(w: PushWorld, page: Page, context: BrowserContext, o: { neverReady?: boolean } = {}): Promise<Sub> {
  const sub = newSub();
  const fake: Fake = { endpoint: sub.endpoint, ...subBody(sub).keys, neverReady: o.neverReady ?? false };
  await context.addInitScript((f: Fake) => {
    let held: unknown = null;
    const made = { endpoint: f.endpoint, toJSON: () => ({ endpoint: f.endpoint, keys: { p256dh: f.p256dh, auth: f.auth } }) };
    Object.defineProperty(ServiceWorkerRegistration.prototype, "pushManager", {
      configurable: true,
      get: () => ({ getSubscription: async () => held, subscribe: async () => (held = made) }),
    });
    // The prompt takes a moment, as it does on a phone.
    let permission = "default";
    Object.defineProperty(Notification, "permission", { configurable: true, get: () => permission });
    Notification.requestPermission = async () => {
      await new Promise((r) => setTimeout(r, 700));
      return (permission = "granted") as NotificationPermission;
    };
    if (f.neverReady) Object.defineProperty(navigator.serviceWorker, "ready", { configurable: true, get: () => new Promise(() => {}) });
  }, fake);
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
