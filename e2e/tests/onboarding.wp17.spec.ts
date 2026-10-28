import type { Page } from "@playwright/test";
import { expect, scenario } from "../lib/scenario.ts";
import { installFakePhone } from "../lib/push-phone.ts";
import { newChat } from "../lib/chat-ui.ts";
import { installed, world } from "../lib/wp17.ts";

/*
 * PWA (WP17), installing the app. Settings → Notifications is the "Notifications" row of /settings; the guide is the region named
 * "Add to Home Screen". A new build's worker takes over by itself and the page reloads under it; the worker that runs is told apart by
 * its script URL. The page is never made to message the running worker for it: a message wakes the outgoing worker while the new one
 * takes over, which can stall that hand-over. A pull to refresh is raw CDP touch events: Playwright's touchscreen only taps.
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

/** The script URL of the worker that controls the page; "reloading" while the page reloads under a new one. */
const running = (page: Page) => page.evaluate(() => navigator.serviceWorker.controller?.scriptURL ?? "none").catch(() => "reloading");

/**
 * Deploy a new build while the app is open: a worker at another URL of the same scope is what a new build's worker is to the browser.
 * The page that registers it is reloaded under it, so the evaluate may lose its page; that is the point.
 */
const deploy = (page: Page) =>
  page.evaluate(async () => void (await navigator.serviceWorker.register("/sw.js?build=2", { type: "module", scope: "/" }))).catch((err: Error) => {
    if (!/context was destroyed|Target .*closed|navigat/i.test(err.message)) throw err; // a failed register is not a reload
  });

/** The workers of the scope by state, to name the one that never took over when the update does not. */
const workers = (page: Page) =>
  page
    .evaluate(async () => {
      const r = await navigator.serviceWorker.getRegistration("/");
      const at = (w?: ServiceWorker | null) => (w ? `${w.scriptURL} (${w.state})` : "none");
      // A worker waits while the old one still has a request in flight (a stream the page holds): name those requests.
      const open = performance
        .getEntriesByType("resource")
        .filter((e) => (e as PerformanceResourceTiming).responseEnd === 0)
        .map((e) => e.name.replace(location.origin, ""));
      return `installing ${at(r?.installing)}, waiting ${at(r?.waiting)}, active ${at(r?.active)}, controller ${at(navigator.serviceWorker.controller)}, requests still open ${JSON.stringify(open)}`;
    })
    .catch((err: Error) => `unreadable: ${err.message}`);

scenario("An update takes over by itself", { tag: ["@browser"] }, async ({ server, page, context }, info) => {
  info.setTimeout(90_000);
  const u = await world({ server, page, context });
  let loads = 0;
  page.on("load", () => loads++);
  await page.goto(`${u.w.srv.origin}/`);
  await installed(page);
  const before = await running(page);
  // The first worker took the page without a reload: it replaced nothing.
  expect(loads).toBe(1);

  // Given a new build is deployed while the app is open
  await deploy(page);

  // Then the new version runs without a tap
  await expect.poll(() => running(page), { timeout: 30_000 }).toContain("build=2").catch(async (err: Error) => {
    throw new Error(`${err.message}\nworkers: ${await workers(page)}`);
  });
  expect(before).not.toContain("build=2");

  // And the page reloads once
  await expect.poll(() => loads, { timeout: 10_000 }).toBe(2);
  await page.waitForTimeout(1500); // a second reload, if one were coming, starts within this time
  expect(loads).toBe(2);
});

scenario("A half-written message survives an update", { tag: ["@browser"] }, async ({ server, page, context }, info) => {
  info.setTimeout(90_000);
  const u = await world({ server, page, context });
  await page.goto(`${u.w.srv.origin}/chats`);
  await installed(page);
  // The composer is open before the build is deployed: a page change in the same moment can stall the worker's hand-over.
  await newChat(page).click();
  const box = page.getByRole("textbox", { name: "Message", exact: true });
  await expect(box).toBeVisible();

  // Given the owner has typed a message and not sent it
  await box.fill("half a thought");
  let reloaded = false;
  page.on("load", () => (reloaded = true));

  // When a new build is deployed while the app is open
  await deploy(page);

  // Then the new version runs without a tap
  await expect.poll(() => running(page), { timeout: 30_000 }).toContain("build=2");
  await expect.poll(() => reloaded, { timeout: 10_000 }).toBe(true); // the box below is a new page's, not the old one kept

  // And the typed message is still in the box
  await expect(box).toHaveValue("half a thought");
});

/** A finger pulls straight down by `by` px from (x, y) and lets go: raw touch events, as a phone sends them. */
async function pullDown(page: Page, x: number, y: number, by: number): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
  for (let step = 1; step <= 5; step++) await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: y + (by * step) / 5 }] });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await cdp.detach().catch(() => {}); // the page may already be reloading
}

scenario("A pull down at the top of a list refreshes the app", { tag: ["@browser", "@phone"] }, async ({ server, page, context }) => {
  // Every look for a new build is noted with the page that asked (its time origin), in storage that outlives a reload.
  await context.addInitScript(() => {
    const update = ServiceWorkerRegistration.prototype.update;
    ServiceWorkerRegistration.prototype.update = function () {
      const asked = JSON.parse(sessionStorage.getItem("e2e.updates") ?? "[]") as number[];
      sessionStorage.setItem("e2e.updates", JSON.stringify([...asked, performance.timeOrigin]));
      return update.call(this);
    };
  });
  const u = await world({ server, page, context });

  // Given the app is open on a phone
  await page.goto(`${u.w.srv.origin}/chats`);
  await installed(page);
  // The owner has no conversation yet: the list is its empty state, which a pull refreshes all the same.
  const list = page.getByRole("main");
  await expect(list.getByText("No conversations yet")).toBeVisible();
  const first = await page.evaluate(() => performance.timeOrigin);
  const asked = () => page.evaluate(() => JSON.parse(sessionStorage.getItem("e2e.updates") ?? "[]") as number[]).catch(() => []);
  const before = (await asked()).filter((o) => o === first).length;
  let reloaded = false;
  page.on("load", () => (reloaded = true));

  // When the owner pulls down at the top of the conversations list
  const box = (await list.boundingBox())!;
  await pullDown(page, box.x + box.width / 2, box.y + 20, 150);

  // Then the app looks for a new build and reloads
  await expect.poll(() => reloaded, { timeout: 10_000 }).toBe(true);
  expect((await asked()).filter((o) => o === first).length).toBeGreaterThan(before);
  await expect(list.getByText("No conversations yet")).toBeVisible();
});
