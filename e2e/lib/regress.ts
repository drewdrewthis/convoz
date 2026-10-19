import fs from "node:fs";
import path from "node:path";
import type { BrowserContext, Locator, Page, TestInfo } from "@playwright/test";
import type { ServerHandle, ServerOptions, TestApiFactory } from "./fixtures.ts";
import { setServerTime } from "./asks.ts";
import { expect } from "./scenario.ts";
import { protoWorld } from "./prototype-seed.ts";
import type { UiWorld } from "./chat-ui.ts";

/**
 * APP REGRESSION: the app against its own reviewed frames (specs/features/app-regress.feature). Each screen is shot in light and in dark
 * and checked twice: the box of every element that matches BOXED must equal the stored box within BOX_TOLERANCE px, and the pixels may
 * differ in at most MAX_DIFF_PIXELS. The reference lives in visual/regress/<project>/<screen>-<scheme>.png and .boxes.json.
 *
 * Writing the references is a human act: REGRESS_WRITE=1 pnpm --filter @convoz/e2e exec playwright test tests/app-regress.spec.ts
 * (see e2e/visual/regress/README.md). Without that variable nothing under visual/regress is ever written.
 */

/** The instant the server clock and the browser clock are both frozen at, so every age and time reads the same on every run. */
export const FROZEN_AT = "2026-10-16T18:00:00Z";

export const BOX_TOLERANCE = 0.5;
export const MAX_DIFF_PIXELS = 200;

/** The elements whose boxes are asserted: controls, headings, links, dialogs, menus and rows. Browsers draw them the same way every run. */
export const BOXED =
  "button,input,textarea,select,a[href],h1,h2,h3,time,img,svg,nav,[role=article],[role=dialog],[role=menu],[role=menuitem],[role=option],[role=radio],[role=checkbox],[role=tab],.preview,.count";

type Box = [x: number, y: number, w: number, h: number];
interface BoxFile {
  viewport: [number, number];
  boxes: Record<string, Box>;
}

const root = path.join(import.meta.dirname, "..", "visual", "regress");
const writing = process.env.REGRESS_WRITE === "1";

/** The world of the prototype's sample data with both clocks frozen at FROZEN_AT (server first, so what is seeded afterwards carries that time). */
export async function frozenWorld(
  fx: { server: (o?: ServerOptions) => Promise<ServerHandle>; page: Page; context: BrowserContext; testApi: TestApiFactory },
  o: { agents: string[]; live: string[]; disabled?: string[]; dataDir?: string },
): Promise<UiWorld> {
  const u = await protoWorld(fx, o);
  await freezeClocks(fx.page, fx.testApi(u.w.srv), u);
  return u;
}

export async function freezeClocks(page: Page, testApi: ReturnType<TestApiFactory>, u: UiWorld): Promise<void> {
  await setServerTime(testApi, u.w.owner, FROZEN_AT);
  await page.clock.setFixedTime(FROZEN_AT);
}

/** Every matching box on the page, keyed by tag, role, name and the n-th time that key occurs: `button "Snooze"#1`. */
async function boxesOf(page: Page, ignore: string): Promise<BoxFile> {
  return page.evaluate(
    ([sel, skip]) => {
      const seen = new Map<string, number>();
      const boxes: Record<string, [number, number, number, number]> = {};
      for (const n of document.querySelectorAll(sel!)) {
        if (skip && n.closest(skip)) continue;
        const r = n.getBoundingClientRect();
        if (!r.width || !r.height) continue;
        const name = n.getAttribute("aria-label") || (n.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 40) || n.getAttribute("placeholder") || "";
        const base = `${n.tagName.toLowerCase()}${n.getAttribute("role") ? `[${n.getAttribute("role")}]` : ""} ${JSON.stringify(name)}`;
        const k = seen.get(base) ?? 0;
        seen.set(base, k + 1);
        boxes[`${base}#${k}`] = [Math.round(r.x * 100) / 100, Math.round(r.y * 100) / 100, Math.round(r.width * 100) / 100, Math.round(r.height * 100) / 100];
      }
      return { viewport: [window.innerWidth, window.innerHeight] as [number, number], boxes };
    },
    [BOXED, ignore] as const,
  );
}

/** One line per element that is missing, new or off by more than BOX_TOLERANCE px, naming the element and both boxes. */
function boxDiff(want: BoxFile, got: BoxFile): string[] {
  const out: string[] = [];
  if (want.viewport.join("x") !== got.viewport.join("x")) out.push(`viewport ${want.viewport.join("x")} -> ${got.viewport.join("x")}`);
  for (const [key, w] of Object.entries(want.boxes)) {
    const g = got.boxes[key];
    if (!g) out.push(`${key}: gone (was [${w}])`);
    else if (w.some((v, i) => Math.abs(v - g[i]!) > BOX_TOLERANCE)) out.push(`${key}: [x,y,w,h] [${w}] -> [${g}]`);
  }
  for (const [key, g] of Object.entries(got.boxes)) if (!want.boxes[key]) out.push(`${key}: new at [${g}]`);
  return out;
}

async function settle(page: Page, scheme: "light" | "dark"): Promise<void> {
  await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" });
  await page.evaluate(() => document.fonts.ready);
  await expect.poll(() => page.evaluate(() => document.documentElement.getAttribute("data-theme")), { message: `the app paints ${scheme}` }).toBe(scheme);
  await expect.poll(() => page.evaluate(() => document.getAnimations().length), { message: "no animation is running" }).toBe(0);
  await page.mouse.move(0, 0); // no hover state on a row
}

export interface ShotOptions {
  /** Elements whose text is dynamic by nature (a timing): painted over in the pixels, left out of the boxes. */
  mask?: Locator[];
  /** CSS selector of subtrees left out of the boxes. */
  ignore?: string;
}

/**
 * Light then dark: boxes first (so a layout move is named by element), then pixels. Both checks are soft, so one run reports every
 * screen and both checks that moved. With REGRESS_WRITE=1 the references are written instead.
 */
export async function matchesItself(page: Page, info: TestInfo, screen: string, o: ShotOptions = {}): Promise<void> {
  const dir = path.join(root, info.project.name);
  for (const scheme of ["light", "dark"] as const) {
    await settle(page, scheme);
    const name = `${screen}-${scheme}`;
    const got = await boxesOf(page, o.ignore ?? "");
    const shot = { animations: "disabled", caret: "hide", scale: "device", mask: o.mask ?? [], maskColor: "#808080" } as const;
    if (writing) {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${name}.boxes.json`), `${JSON.stringify(got, null, 1)}\n`);
      await page.screenshot({ path: path.join(dir, `${name}.png`), ...shot });
      continue;
    }
    const file = path.join(dir, `${name}.boxes.json`);
    expect.soft(fs.existsSync(file), `${info.project.name}/${name}: no stored boxes (a human writes them: REGRESS_WRITE=1)`).toBe(true);
    if (fs.existsSync(file)) expect.soft(boxDiff(JSON.parse(fs.readFileSync(file, "utf8")) as BoxFile, got), `${info.project.name}/${name}: element boxes moved`).toEqual([]);
    await expect.soft(page).toHaveScreenshot(["regress", info.project.name, `${name}.png`], { ...shot, maxDiffPixels: MAX_DIFF_PIXELS });
  }
}
