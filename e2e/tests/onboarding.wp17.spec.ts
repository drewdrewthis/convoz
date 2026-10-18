import { expect, scenario } from "../lib/scenario.ts";
import { installFakePhone } from "../lib/push-phone.ts";
import { installed, world } from "../lib/wp17.ts";

/*
 * PWA (WP17), installing the app. Settings → Notifications is the "Notifications" row of /settings; the guide is the region named
 * "Add to Home Screen". An update that waits is the status line "Update ready · Reload" (button "Reload"); the worker that runs is told
 * apart by its script URL. The page is never made to message the running worker for it: a message wakes the outgoing worker while
 * the new one takes over, which can stall that hand-over.
 */

const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";

scenario("iPhone users get an Add to Home Screen guide", { tag: ["@browser", "@phone"] }, async ({ server, page, context, browser }) => {
  const u = await world({ server, page, context });
  // Given an iPhone browser that is not in standalone mode
  const phone = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    userAgent: IPHONE,
    storageState: await context.storageState(),
  });
  // The app asks the browser, not the UA: a Safari tab on iOS has no PushManager and says vendor "Apple Computer, Inc."; Chromium has the first and says "Google Inc.", which reads as Chrome.
  await installFakePhone(phone, { supported: false });
  await phone.addInitScript(() => Object.defineProperty(Navigator.prototype, "vendor", { configurable: true, get: () => "Apple Computer, Inc." }));
  const iphone = await phone.newPage();
  expect(await iphone.evaluate(() => matchMedia("(display-mode: standalone)").matches)).toBe(false);

  // When the owner opens Settings → Notifications
  await iphone.goto(`${u.w.srv.origin}/settings`);
  await iphone.getByRole("button", { name: "Notifications" }).click();

  // Then a guide card explains "Share → Add to Home Screen" before push can be turned on
  const guide = iphone.getByRole("region", { name: "Add to Home Screen" });
  await expect(guide).toBeVisible();
  await expect(guide).toContainText("Share → Add to Home Screen");
  await expect(iphone.getByRole("button", { name: /push/i })).toHaveCount(0);
  await phone.close();

  // Any other browser has no such guide
  await page.goto(`${u.w.srv.origin}/settings`);
  await page.getByRole("button", { name: "Notifications" }).click();
  await expect(page.getByRole("heading", { name: "Notifications" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Add to Home Screen" })).toHaveCount(0);
});

scenario("An update waits for the owner's tap", { tag: ["@browser"] }, async ({ server, page, context }, info) => {
  info.setTimeout(90_000);
  const u = await world({ server, page, context });
  await page.goto(`${u.w.srv.origin}/`);
  await installed(page);
  const instance = () => page.evaluate(() => navigator.serviceWorker.controller?.scriptURL ?? "none");
  const before = await instance();

  // Given a new build is deployed while the app is open
  // (A browser takes a script at another URL of the same scope as a new version, which is what a new build's worker is.)
  await page.evaluate(async () => void (await navigator.serviceWorker.register("/sw.js?build=2", { type: "module", scope: "/" })));

  // Then the app shows "Update ready · Reload"
  const note = page.getByRole("status").filter({ hasText: "Update ready · Reload" });
  await expect(note).toBeVisible({ timeout: 30_000 });

  // And the new version runs only after the owner taps Reload
  expect(await page.evaluate(async () => (await navigator.serviceWorker.getRegistration())!.waiting !== null)).toBe(true);
  expect(await instance()).toBe(before);
  await page.reload();
  expect(await instance()).toBe(before);
  await expect(note).toBeVisible();
  await note.getByRole("button", { name: "Reload" }).click();
  await expect
    .poll(
      async () => {
        try {
          return await instance();
        } catch {
          return before; // the page is reloading under the new worker
        }
      },
      { timeout: 30_000 },
    )
    .not.toBe(before);
  await expect(page.getByRole("status").filter({ hasText: "Update ready" })).toHaveCount(0);
});
