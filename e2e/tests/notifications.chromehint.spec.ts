import { installFakeBrowser } from "../lib/chrome-ios.ts";
import { signInBrowser } from "../lib/machines.ts";
import { installFakePhone } from "../lib/push-phone.ts";
import { pushWorld } from "../lib/push-wp14.ts";
import { expect, scenario } from "../lib/scenario.ts";

// The owner (Drew, ask 119): "Chrome". Chrome on iPhone has no web push, and the app says so.

const SAID = "Chrome on iPhone has no notifications for web apps. Open Convoz in Safari and add it to the Home Screen from there.";

scenario("Settings tells Chrome on iPhone to use Safari", { tag: ["@browser"] }, async ({ server, dataDir, page, context }, info) => {
  info.setTimeout(60_000);
  const w = await pushWorld(server, dataDir);
  await installFakePhone(context, { supported: false });
  await installFakeBrowser(context, { chromeIos: true });
  await signInBrowser(w.srv, w.owner, page, context);
  await page.goto(`${w.srv.origin}/settings`);
  await expect(page.getByText("This device", { exact: true }).locator("..")).toContainText(SAID);
});

scenario("The banner tells Chrome on iPhone to use Safari and can be dismissed", { tag: ["@browser"] }, async ({ server, dataDir, page, context }, info) => {
  info.setTimeout(60_000);
  const w = await pushWorld(server, dataDir);
  await installFakePhone(context, { supported: false });
  await installFakeBrowser(context, { chromeIos: true });
  await signInBrowser(w.srv, w.owner, page, context);
  await page.goto(`${w.srv.origin}/chats`);
  const banner = page.getByRole("region", { name: "Notifications" });
  await expect(banner).toContainText(SAID);
  await expect(banner.getByRole("button", { name: "Turn on", exact: true })).toHaveCount(0);
  await banner.getByRole("button", { name: "Dismiss" }).click();
  await page.reload();
  await expect(page.getByRole("heading", { name: "Conversations", level: 1 })).toBeVisible();
  await expect(banner).toHaveCount(0);
});
