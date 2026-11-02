import { TITLES, openRail, rail, railRow, railWorld } from "../lib/rail-wp9.ts";
import { expect, scenario } from "../lib/scenario.ts";

/*
 * rail.feature, "The owner resizes the sidebar and the width is remembered" (owner, conv 179 msg 9346). THE PAGE the binding relies on:
 *   At 900 px or more the rail has, on its right edge, a separator named "Resize sidebar" (focusable; aria-valuenow, aria-valuemin and
 *   aria-valuemax are its width in px). Drag moves it, Left and Right arrows change it, a double click restores the first width.
 *   The width is kept in this browser and applies before the first paint.
 */

const [T41] = TITLES;

scenario("The owner resizes the sidebar and the width is remembered", { tag: ["@browser"] }, async ({ server, page, context }) => {
  // Given the owner has conversation 41 open on a wide screen
  const u = await railWorld({ server, page, context });
  await openRail(page, u.w.srv, `/chats/${u.c[41]}`);
  await expect(page.getByRole("heading", { name: T41, level: 1 })).toBeVisible();
  const handle = page.getByRole("separator", { name: "Resize sidebar" });
  const width = async () => Math.round((await rail(page).boundingBox())!.width);
  const frameLeft = async () => Math.round((await page.locator(".chatframe").boundingBox())!.x);
  const first = await width();

  // Then the handle does not cover the end of a row: its star works at the default width
  await railRow(page, T41).hover();
  await railRow(page, T41).getByRole("button", { name: /^Star conversation/ }).click();
  await expect(railRow(page, T41).getByRole("button", { name: /^Unstar conversation/ })).toBeVisible();

  // When the owner drags the handle 80 px to the right
  const at = (await handle.boundingBox())!;
  const y = at.y + at.height / 2;
  await page.mouse.move(at.x + at.width / 2, y);
  await page.mouse.down();
  await page.mouse.move(at.x + at.width / 2 + 80, y, { steps: 8 });
  await page.mouse.up();

  // Then the sidebar is 80 px wider and the conversation moves with it
  await expect.poll(width).toBe(first + 80);
  expect(await frameLeft()).toBe(first + 80);

  // When the owner reloads the page, then the sidebar has the same width
  await page.reload();
  await expect(rail(page)).toBeVisible();
  expect(await width()).toBe(first + 80);

  // When the owner presses the Left arrow on the handle, then the sidebar is narrower
  await handle.focus();
  await page.keyboard.press("ArrowLeft");
  await expect.poll(width).toBeLessThan(first + 80);

  // When the owner double-clicks the handle, then the sidebar has its first width again
  await handle.dblclick();
  await expect.poll(width).toBe(first);

  // Then the handle is gone when the sidebar is folded
  await rail(page).getByRole("button", { name: "Hide sidebar" }).click();
  await expect(page.getByRole("separator", { name: "Resize sidebar" })).toHaveCount(0);

  // And on a narrow screen there is no sidebar to resize
  await rail(page).getByRole("button", { name: "Show sidebar" }).click();
  await page.setViewportSize({ width: 800, height: 800 });
  await expect(page.getByRole("separator", { name: "Resize sidebar" })).toHaveCount(0);
});
