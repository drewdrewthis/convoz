import type { BrowserContext, Locator, Page, TestInfo } from "@playwright/test";
import type { Owner } from "./owner.ts";
import { must } from "./owner.ts";
import { withStepUp, stepUp } from "./machines.ts";
import { SoftAuthenticator } from "./soft-authenticator.ts";
import type { ServerHandle } from "./fixtures.ts";
import { webauthn } from "./webauthn-browser.ts";
import { uiSignIn } from "./owner.ts";

/** A second passkey for `owner` made over the API ("session" registration, with a passkey step-up). Returns the new soft key. */
export async function addSecondPasskey(srv: ServerHandle, owner: Owner): Promise<SoftAuthenticator> {
  const soft = new SoftAuthenticator(srv.host, srv.origin);
  const sid = await stepUp(owner, "passkey.add");
  const opt = must(await owner.client.post("/api/auth/passkey/register/options", {}), "register options").json();
  must(
    await owner.client.post("/api/auth/passkey/register/verify", { ceremony_id: opt.ceremony_id, credential: soft.create(opt.options.publicKey) }, withStepUp(sid)),
    "register verify",
  );
  return soft;
}

/** Put the owner's passkey on a fresh virtual authenticator and sign in through the page. Returns the authenticator. */
export async function signInWith(srv: ServerHandle, soft: SoftAuthenticator, page: Page, context: BrowserContext) {
  const wa = await webauthn(context, page);
  const device = await wa.add();
  await device.addCredential(soft.exportForChromium());
  await uiSignIn(page, srv.origin);
  return { wa, device };
}

/** The widest a page is past the screen, in CSS px (0 means no sideways scroll). */
export const overflowX = (page: Page): Promise<number> => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

/** The element's box. A page may swap the node under a locator (a sent message is replaced by its stored copy), so a missing box is retried for a second. */
export async function box(l: Locator): Promise<{ x: number; y: number; width: number; height: number }> {
  for (let tries = 0; tries < 20; tries++) {
    const b = await l.boundingBox();
    if (b) return b;
    await l.page().waitForTimeout(50);
  }
  throw new Error("element has no box (not visible)");
}

/** Luminance 0..1 of the page background. */
export async function backgroundLuminance(page: Page): Promise<number> {
  return page.evaluate(() => {
    // The computed colour may be rgb() or, for a colour-mix() background, color(srgb 0..1): a canvas turns either into bytes.
    const ctx = document.createElement("canvas").getContext("2d", { willReadFrequently: true })!;
    ctx.fillStyle = getComputedStyle(document.body).backgroundColor;
    ctx.fillRect(0, 0, 1, 1);
    const [r, g, b] = Array.from(ctx.getImageData(0, 0, 1, 1).data, (v) => v / 255);
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
  });
}

/** Attach a screenshot of the page in dark and in light for the proof report. */
export async function shootBoth(page: Page, info: TestInfo, name: string): Promise<void> {
  for (const scheme of ["dark", "light"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await info.attach(`${name} (${scheme})`, { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });
  }
}

/** Visible buttons, menu items and fields smaller than 44 px tall: "tag name x height". */
export function smallTargets(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    for (const e of document.querySelectorAll<HTMLElement>('button, [role="menuitem"], input:not([type="checkbox"]):not([type="radio"]), nav a, header a')) {
      const r = e.getBoundingClientRect();
      if (r.width === 0 || r.height === 0 || e.closest("[hidden]")) continue;
      if (r.height < 43.5) out.push(`${e.tagName.toLowerCase()} "${(e.textContent || e.getAttribute("aria-label") || "").trim().slice(0, 30)}" ${Math.round(r.height)}px`);
    }
    return out;
  });
}
