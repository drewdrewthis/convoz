import type { Page } from "@playwright/test";
import { signInBrowser } from "../lib/machines.ts";
import { addSecondPasskey, backgroundLuminance, signInWith } from "../lib/mobile.ts";
import { apiServer, bootstrapOwner, must } from "../lib/owner.ts";
import { expect, scenario } from "../lib/scenario.ts";

// WP13's part of settings.feature. Page and API contract (the web app is the React app; locators are role and name only):
//
//   /settings        heading "Settings" (level 1). Radio groups "Theme" (Light, Dark, System), "Palette" (Iris, Ember, Mono, Tide),
//                    "Text size" (S, M, L, XL). Link "Privacy & security" (to /settings/privacy). A choice applies at once.
//   /settings/privacy  heading "Privacy & security". List "Privacy and security": Devices, Passkeys, Machines, Sessions,
//                    Sign out all other devices, Export my data, Delete my data. No access-token row (PATs are gone).
//   <html>           data-theme = "light" | "dark" (the resolved look), data-palette, data-text-size. A classic script
//                    /assets/settings/theme-boot.js in <head> sets them before the first paint from the device's own storage and,
//                    for "system", follows the OS scheme live.
//   Device settings (theme, text_size, ...) live in the browser only: never in GET /api/settings.
//   GET /api/settings  -> {settings:[{scope:"workspace"|"user", key, value}]} every registry key, its default when never set.
//   PATCH /api/settings {scope,key,value} -> 200 {scope,key,value}; unknown key, wrong type or wrong scope -> 400 (I-29).
//   The palette is a user setting: it follows the owner to every device on its next load.

const local = { host: "localhost", adminSocket: true } as const;

const html = (page: Page, attr: string): Promise<string | null> => page.evaluate((a) => document.documentElement.getAttribute(a), attr);
const accent = (page: Page): Promise<string> => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--color-accent").trim());
const bodyFont = (page: Page): Promise<string> => page.evaluate(() => getComputedStyle(document.body).fontSize);

scenario("The system theme switches live", { tag: ["@browser"] }, async ({ server, page, context }) => {
  // Given the theme setting is "system" and the system is light
  const srv = await server(local);
  const owner = await bootstrapOwner(srv);
  await signInBrowser(srv, owner, page, context);
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto(`${srv.origin}/settings`);
  await expect(page.getByRole("radio", { name: "System" })).toBeChecked();
  await expect.poll(() => html(page, "data-theme")).toBe("light");
  expect(await backgroundLuminance(page)).toBeGreaterThan(0.8);
  await page.evaluate(() => ((window as any).__same = true));
  const before = await page.screenshot();

  // When the system switches to dark
  await page.emulateMedia({ colorScheme: "dark" });

  // Then the app turns dark with no reload
  await expect.poll(() => html(page, "data-theme")).toBe("dark");
  expect(await page.evaluate(() => (window as any).__same)).toBe(true);
  expect(await backgroundLuminance(page)).toBeLessThan(0.2);

  // And the screenshots before and after show no unstyled frame
  const after = await page.screenshot();
  expect(before.equals(after)).toBe(false);
  for (const shot of [before, after]) expect(shot.length).toBeGreaterThan(2_000); // a flat default-white page compresses far smaller
  await expect(page.getByRole("heading", { name: "Settings", level: 1 })).toBeVisible();
});

scenario("A reload in dark mode paints dark from the first frame", { tag: ["@browser"] }, async ({ server, page, context }) => {
  // Given the theme setting is "dark" (while the system is light)
  const srv = await server(local);
  const owner = await bootstrapOwner(srv);
  await signInBrowser(srv, owner, page, context);
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto(`${srv.origin}/settings`);
  await page.getByRole("radio", { name: "Dark" }).check();
  await expect.poll(() => html(page, "data-theme")).toBe("dark");

  // When the owner reloads the app
  await page.addInitScript(() => {
    const w = window as any;
    w.__themeSeen = [];
    // The init script runs before <html> exists, so it watches the document.
    new MutationObserver(() => {
      const v = document.documentElement?.getAttribute("data-theme");
      if (v && !w.__themeSeen.length) w.__themeSeen.push({ v, at: performance.now() });
    }).observe(document, { attributes: true, subtree: true, attributeFilter: ["data-theme"] });
  });
  await page.reload();
  await expect(page.getByRole("heading", { name: "Settings", level: 1 })).toBeVisible();

  // Then the first painted frame is dark: the theme was set before the first paint, to dark, and nothing changed it after
  const seen = await page.evaluate(() => {
    const w = window as any;
    const paint = performance.getEntriesByName("first-paint")[0];
    return { first: w.__themeSeen[0], paintAt: paint?.startTime, now: document.documentElement.getAttribute("data-theme") };
  });
  expect(seen.first?.v).toBe("dark");
  expect(seen.paintAt).toBeDefined();
  expect(seen.first.at).toBeLessThan(seen.paintAt);
  expect(seen.now).toBe("dark");
  expect(await backgroundLuminance(page)).toBeLessThan(0.2);
});

scenario("Device settings stay on the device", { tag: ["@browser"] }, async ({ server, page, context, browser }) => {
  // Given the owner has a laptop and a phone, each with its own passkey
  const srv = await server(local);
  const owner = await bootstrapOwner(srv);
  const phoneKey = await addSecondPasskey(srv, owner);
  await signInBrowser(srv, owner, page, context);

  // And the owner sets text size "xl" on the laptop
  await page.goto(`${srv.origin}/settings`);
  await page.getByRole("radio", { name: "XL", exact: true }).check();
  await expect.poll(() => html(page, "data-text-size")).toBe("xl");
  const laptopFont = await bodyFont(page);

  // When the owner opens the app on the phone
  const phoneCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  try {
    const phone = await phoneCtx.newPage();
    await signInWith(srv, phoneKey, phone, phoneCtx);
    await phone.goto(`${srv.origin}/settings`);

    // Then the phone still uses text size "m"
    await expect(phone.getByRole("radio", { name: "M", exact: true })).toBeChecked();
    await expect.poll(() => html(phone, "data-text-size")).toBe("m");
    expect(await bodyFont(phone)).not.toBe(laptopFont);
  } finally {
    await phoneCtx.close();
  }

  // And the server never saw the device setting
  const keys = must(await owner.client.get("/api/settings"), "read settings").json().settings.map((s: { key: string }) => s.key);
  expect(keys).not.toContain("text_size");
});

scenario("The palette follows the owner across devices", { tag: ["@browser"] }, async ({ server, page, context, browser }) => {
  // Given the owner has a laptop and a phone, each with its own passkey
  const srv = await server(local);
  const owner = await bootstrapOwner(srv);
  const phoneKey = await addSecondPasskey(srv, owner);
  await signInBrowser(srv, owner, page, context);
  await page.goto(`${srv.origin}/settings`);
  await expect.poll(() => html(page, "data-palette")).toBe("iris");
  const irisAccent = await accent(page);

  // When the owner picks a different palette on the laptop
  await page.getByRole("radio", { name: "Ember" }).check();
  await expect.poll(() => html(page, "data-palette")).toBe("ember");
  expect(await accent(page)).not.toBe(irisAccent);
  const settings = must(await owner.client.get("/api/settings"), "read settings").json().settings;
  expect(settings.find((s: { key: string }) => s.key === "palette")).toMatchObject({ scope: "user", value: "ember" });

  // Then the phone uses the same palette after its next sync
  const phoneCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  try {
    const phone = await phoneCtx.newPage();
    await signInWith(srv, phoneKey, phone, phoneCtx);
    await expect.poll(() => html(phone, "data-palette")).toBe("ember");
    expect(await accent(phone)).toBe(await accent(page));
  } finally {
    await phoneCtx.close();
  }
});

scenario("A setting never changed reads as its default", { tag: ["@api"] }, async ({ server }) => {
  // Given a fresh server with owner "drew"
  const srv = await server(apiServer());
  const owner = await bootstrapOwner(srv);

  // When the owner reads the settings
  const read = must(await owner.client.get("/api/settings"), "read settings").json().settings as { scope: string; key: string; value: unknown }[];
  const value = (key: string) => read.find((s) => s.key === key)?.value;

  // Then "notify.previews" is "full", "notify.machine_requests" is true, "notify.urgent_bypass" is true and "brief.max_bytes" is 12288
  expect(value("notify.previews")).toBe("full");
  expect(value("notify.machine_requests")).toBe(true);
  expect(value("notify.urgent_bypass")).toBe(true);
  expect(value("brief.max_bytes")).toBe(12288);
  expect(read.find((s) => s.key === "brief.max_bytes")?.scope).toBe("workspace");
  expect(read.find((s) => s.key === "notify.previews")?.scope).toBe("user");

  // And the server checks every write (I-29): an unknown key, a wrong type, a wrong scope and an out-of-range value are refused
  const patch = (body: unknown) => owner.client.request("PATCH", "/api/settings", { csrf: true, json: body });
  expect((await patch({ scope: "user", key: "no.such.key", value: 1 })).status).toBe(400);
  expect((await patch({ scope: "user", key: "notify.urgent_bypass", value: "yes" })).status).toBe(400);
  expect((await patch({ scope: "workspace", key: "notify.previews", value: "none" })).status).toBe(400);
  expect((await patch({ scope: "workspace", key: "brief.max_bytes", value: 100 })).status).toBe(400);
  expect((await patch({ scope: "workspace", key: "brief.max_bytes", value: 12000 })).status).toBe(200);
  const after = must(await owner.client.get("/api/settings"), "read settings").json().settings as { key: string; value: unknown }[];
  expect(after.find((s) => s.key === "brief.max_bytes")?.value).toBe(12000);
});

scenario("Privacy and security lists what the owner controls", { tag: ["@browser"] }, async ({ server, page, context }) => {
  // Given the owner is signed in
  const srv = await server(local);
  const owner = await bootstrapOwner(srv);
  await signInBrowser(srv, owner, page, context);

  // When the owner opens Settings → Privacy & security
  await page.goto(`${srv.origin}/settings`);
  await page.getByRole("link", { name: "Privacy & security" }).click();
  await expect(page.getByRole("heading", { name: "Privacy & security", level: 1 })).toBeVisible();

  // Then it lists devices, passkeys, machines, sessions, sign out all, export and delete
  const rows = page.getByRole("list", { name: "Privacy and security" }).getByRole("listitem");
  await expect(rows).toHaveCount(7);
  const want = [/Devices/, /Passkeys/, /Machines/, /Sessions/, /Sign out all/, /Export/, /Delete/];
  for (const [i, re] of want.entries()) await expect(rows.nth(i)).toContainText(re);

  // And it does not list personal access tokens
  expect(await page.locator("main, body").first().innerText()).not.toMatch(/access token/i);
});
