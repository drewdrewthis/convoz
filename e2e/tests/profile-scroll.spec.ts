import { labelledSession, crewWorld } from "../lib/crew-wp9.ts";
import { convoz } from "../lib/chat.ts";
import { expect, scenario } from "../lib/scenario.ts";
import type { Page } from "@playwright/test";

/*
 * crew.feature, Rule "A long agent profile scrolls to its last row". Owner said (conv 43 msg 1263): "that page with that button can't scroll".
 * An agent with many sessions and handoff notes has a profile taller than the screen; the "Triage agent" switch is its last row and must be reachable
 * by scrolling with the wheel or a finger, with nothing (the tab bar) over it.
 */

const MANY = 14;

/** Scroll with real wheel input (no scrollIntoView: that moves a box the owner's finger cannot move) until the switch is in view, at most 40 turns. */
async function scrollToTriage(page: Page): Promise<void> {
  const box = page.getByRole("checkbox", { name: "Triage agent" });
  const main = (await page.locator("main").boundingBox())!;
  await page.mouse.move(main.x + main.width / 2, main.y + main.height / 2);
  for (let i = 0; i < 40; i++) {
    const r = await box.boundingBox();
    const bar = await page.locator(".tabbar").boundingBox().catch(() => null);
    const floor = bar && (await page.locator(".tabbar").isVisible()) ? bar.y : page.viewportSize()!.height;
    if (r && r.y >= 0 && r.y + r.height <= floor) break;
    await page.mouse.wheel(0, 400);
    await page.waitForTimeout(50);
  }
}

async function expectReachable(page: Page): Promise<void> {
  await scrollToTriage(page);
  const box = page.getByRole("checkbox", { name: "Triage agent" });
  await expect(box).toBeInViewport({ ratio: 1 });
  const covered = await box.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    return !(hit === el || (hit && (el.closest("label")?.contains(hit) ?? false)));
  });
  expect(covered, "something covers the switch").toBe(false);
  const tabbar = page.locator(".tabbar");
  if (await tabbar.isVisible()) {
    const [b, t] = [await box.boundingBox(), await tabbar.boundingBox()];
    expect(b!.y + b!.height, "the switch ends above the tab bar").toBeLessThanOrEqual(t!.y);
  }
  // A trial click runs every check of a real tap (visible, stable, receives the click there) without switching it on, which asks for a passkey.
  await box.click({ trial: true, timeout: 3_000 });
}

scenario("A long agent profile scrolls to its Triage agent switch", { tag: ["@browser"] }, async ({ server, page, context }, info) => {
  info.setTimeout(240_000);
  // Given "devtool" has 14 live sessions and 14 handoff notes
  const c = await crewWorld({ server, page, context }, { agents: ["devtool"] });
  for (let i = 0; i < MANY; i++) {
    const sid = await labelledSession(c.w.box, "devtool", `claude-long${i}`);
    const res = await convoz(c.w.box, sid, ["handoff", `Note ${i}: ${"a long line of handoff text ".repeat(4)}`]);
    expect(res.code, res.stderr).toBe(0);
  }

  // When the owner opens the profile of "devtool" and scrolls down, on the Sessions tab
  await page.goto(`${c.w.srv.origin}/crew/devtool`);
  await expect(page.getByRole("list", { name: "Sessions" }).getByRole("listitem")).toHaveCount(MANY);
  // Then the Triage agent switch is in view, clear of the tab bar, and it can be switched on
  await expectReachable(page);

  // And the same on the Handoffs tab
  await page.reload();
  await page.getByRole("tab", { name: "Handoffs" }).click();
  await expect(page.getByRole("list", { name: "Handoff notes" }).getByRole("listitem")).toHaveCount(MANY);
  await expectReachable(page);

  // And the same on a phone held sideways (932 wide: the wide layout), on each tab
  await page.setViewportSize({ width: 932, height: 430 });
  await page.getByRole("tab", { name: "Sessions" }).click();
  await expectReachable(page);
  await page.getByRole("tab", { name: "Handoffs" }).click();
  await expectReachable(page);
});
