import type { BrowserContext, Page } from "@playwright/test";
import { signInBrowser } from "../lib/machines.ts";
import { installFakePhone } from "../lib/push-phone.ts";
import { decrypt, pushWorld, received, type PushWorld, type Sub } from "../lib/push-wp14.ts";
import { expect, scenario } from "../lib/scenario.ts";

// The owner (Drew, ask 111): "Banner on first open". A slim "Turn on notifications" banner at the top of the main app until the device
// turns push on or the owner dismisses it. The phone is the fake of notifications.pushfix.spec.ts (lib/push-phone.ts).

type Phone = Parameters<typeof installFakePhone>[1];

async function openConversations(w: PushWorld, page: Page, context: BrowserContext, phone: Phone): Promise<Sub> {
  const sub = await installFakePhone(context, phone);
  await signInBrowser(w.srv, w.owner, page, context);
  await page.goto(`${w.srv.origin}/chats`);
  await expect(page.getByRole("heading", { name: "Conversations", level: 1 })).toBeVisible();
  return sub;
}

const banner = (page: Page) => page.getByRole("region", { name: "Notifications" });

scenario("The banner shows on first open when push is possible and undecided", { tag: ["@browser"] }, async ({ server, dataDir, page, context }, info) => {
  info.setTimeout(60_000);
  const w = await pushWorld(server, dataDir);
  // Given the owner's phone can receive push and has not decided on notifications
  // When the owner opens Conversations
  await openConversations(w, page, context, {});
  // Then the banner "Turn on notifications" shows with a "Turn on" button and a "Dismiss" button
  await expect(banner(page).getByText("Turn on notifications")).toBeVisible();
  await expect(banner(page).getByRole("button", { name: "Turn on", exact: true })).toBeVisible();
  await expect(banner(page).getByRole("button", { name: "Dismiss" })).toBeVisible();
  const box = await banner(page).getByRole("button", { name: "Dismiss" }).boundingBox();
  expect(box!.width).toBeGreaterThanOrEqual(44);
  expect(box!.height).toBeGreaterThanOrEqual(44);
});

scenario("Tapping Turn on subscribes the device and the banner leaves", { tag: ["@browser"] }, async ({ server, dataDir, page, context }, info) => {
  info.setTimeout(60_000);
  const w = await pushWorld(server, dataDir);
  const sub = await openConversations(w, page, context, {});
  // When the owner taps "Turn on" in the banner
  await banner(page).getByRole("button", { name: "Turn on", exact: true }).click();
  await expect(banner(page)).toContainText("Asking iPhone for permission…");
  // Then the banner goes away
  await expect(banner(page)).toHaveCount(0);
  // And the fake push service receives one push titled "Notifications are on"
  const mine = async () => (await received(w.srv)).filter((r) => r.endpoint === sub.endpoint);
  await expect.poll(async () => (await mine()).length, { timeout: 15_000 }).toBe(1);
  expect(decrypt(sub, (await mine())[0]!).title).toBe("Notifications are on");
  // And Settings shows this device as "On"
  await page.goto(`${w.srv.origin}/settings`);
  await expect(page.getByRole("switch", { name: "Push on this device" })).toBeChecked();
});

scenario("Dismissing the banner keeps it gone after a reload", { tag: ["@browser"] }, async ({ server, dataDir, page, context }, info) => {
  info.setTimeout(60_000);
  const w = await pushWorld(server, dataDir);
  await openConversations(w, page, context, {});
  // When the owner dismisses the banner
  await banner(page).getByRole("button", { name: "Dismiss" }).click();
  await expect(banner(page)).toHaveCount(0);
  // And the owner reloads the page
  await page.reload();
  await expect(page.getByRole("heading", { name: "Conversations", level: 1 })).toBeVisible();
  // Then the banner does not show
  await expect(banner(page)).toHaveCount(0);
});

scenario("No banner once notifications are decided", { tag: ["@browser"] }, async ({ server, dataDir, page, context }, info) => {
  info.setTimeout(90_000);
  const w = await pushWorld(server, dataDir);
  // Given the owner's phone has notifications allowed
  await openConversations(w, page, context, { permission: "granted" });
  // Then the banner does not show
  await expect(banner(page)).toHaveCount(0);
  // Given the owner's phone has notifications blocked
  const blocked = await context.newPage();
  await context.addInitScript(() => Object.defineProperty(Notification, "permission", { configurable: true, get: () => "denied" }));
  await blocked.goto(`${w.srv.origin}/chats`);
  await expect(blocked.getByRole("heading", { name: "Conversations", level: 1 })).toBeVisible();
  await expect(banner(blocked)).toHaveCount(0);
});

scenario("No banner when the browser cannot receive push", { tag: ["@browser"] }, async ({ server, dataDir, page, context }, info) => {
  info.setTimeout(60_000);
  const w = await pushWorld(server, dataDir);
  // Given the owner's browser cannot receive push
  await openConversations(w, page, context, { supported: false });
  // Then the banner does not show
  await expect(banner(page)).toHaveCount(0);
});
