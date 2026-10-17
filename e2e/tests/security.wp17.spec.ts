import { expect, scenario } from "../lib/scenario.ts";
import { cacheUrls, installed, world } from "../lib/wp17.ts";

/*
 * SECURITY (WP17), I-39: a key reveal is never handled by the service worker. The reveal is the real UI flow (Crew → Machines →
 * Reveal, a passkey check, the key shown once); then Cache Storage is read for what the worker kept.
 */

scenario("The service worker never caches a reveal", { tag: ["@browser", "@I-39"] }, async ({ server, page, context }, info) => {
  info.setTimeout(90_000);
  const u = await world({ server, page, context });
  const key = u.w.box2.key;

  // Given the installed app revealed the key of "box-2"
  await page.goto(`${u.w.srv.origin}/crew/machines`);
  await installed(page);
  await page.getByRole("button", { name: "Reveal" }).click();
  await page.getByRole("dialog", { name: "Reveal box-2" }).getByRole("button", { name: "Reveal", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Key of box-2" })).toContainText(key);

  // When the browser goes offline and the reveal page is opened again
  await context.setOffline(true);
  await page.goto(`${u.w.srv.origin}/crew/machines`);
  await expect(page.getByRole("heading", { name: "Machines" })).toBeVisible({ timeout: 20_000 });

  // Then no key is shown and the Cache Storage holds no machine response
  await expect(page.locator("body")).not.toContainText(key);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const urls = await cacheUrls(page);
  expect(urls.length, "the worker did cache the app shell").toBeGreaterThan(5);
  expect(urls.filter((url) => url.startsWith("/api/"))).toEqual([]);
});
