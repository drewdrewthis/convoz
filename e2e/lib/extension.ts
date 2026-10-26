import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium, type BrowserContext, type CDPSession, type Page } from "@playwright/test";
import type { ServerHandle } from "./fixtures.ts";
import { signInBrowser } from "./machines.ts";
import type { Owner } from "./owner.ts";
import { repoRoot, run } from "./run.ts";

/**
 * Helpers of browser-extension.feature: the unpacked extension (apps/extension) in a real Chromium against a real `convoz serve`.
 *
 * Two steps of the owner's hand cannot be clicked in a test browser, so the test takes them the way Chrome's own pages do:
 *  - host access: Chrome's prompt for the server origin is browser UI. grantHostAccess adds that origin on chrome://extensions
 *    ("Site access", developerPrivate.addHostPermission), so the panel's own chrome.permissions.request then resolves true.
 *  - the toolbar click: clickConvozButton runs the extension's action on the page's tab over CDP (Extensions.triggerAction),
 *    which grants activeTab on that tab and opens the real side panel, as a click on the button does.
 * The panel is driven in its own popup window (openPanel): the side panel itself is not a page Playwright can reach. Its code
 * is the same file; it reads the active tab of the last focused normal window, which is the page either way.
 */

/** The ID the manifest key pins (apps/extension/README.md). */
export const EXTENSION_ID = "mbdignacpmfihffcpigobpekahlmeleb";
export const EXTENSION_ORIGIN = `chrome-extension://${EXTENSION_ID}`;

let built: Promise<string> | undefined;
/** The extension built once per worker into its own temp dir, so workers do not race on one dist/. */
export function extensionDist(): Promise<string> {
  built ??= (async () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), "convoz-extension-"));
    process.once("exit", () => fs.rmSync(out, { recursive: true, force: true }));
    const r = await run(process.execPath, [path.join(repoRoot, "apps", "extension", "build.mjs"), out], { timeoutMs: 60_000 });
    if (r.code !== 0) throw new Error(`extension build failed:\n${r.stdout}${r.stderr}`);
    return out;
  })();
  return built;
}

/** A fresh Chromium profile with only the Convoz extension loaded. The caller closes it; the profile goes with it. */
export async function launchWithExtension(): Promise<BrowserContext> {
  const dist = await extensionDist();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "convoz-chrome-"));
  const context = await chromium.launchPersistentContext(profile, {
    channel: "chromium",
    headless: true,
    viewport: { width: 1280, height: 800 },
    // the CDP Extensions domain (triggerAction) needs this switch
    args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`, "--enable-unsafe-extension-debugging"],
  });
  // Chrome may still be writing the profile as the context closes: retry, and never fail a test over a temp dir
  context.once("close", () => void fs.promises.rm(profile, { recursive: true, force: true, maxRetries: 10 }).catch(() => {}));
  return context;
}

/** Sign the owner in on the profile's first tab, so the browser holds the Convoz session cookie. */
export async function signInOwner(context: BrowserContext, srv: ServerHandle, owner: Owner): Promise<void> {
  const page = context.pages()[0] ?? (await context.newPage());
  await signInBrowser(srv, owner, page, context);
}

/** What the owner's "Allow" on Chrome's host access prompt does, done on chrome://extensions (see the note at the top). */
export async function grantHostAccess(context: BrowserContext, origin: string): Promise<void> {
  const page = await context.newPage();
  await page.goto(`chrome://extensions/?id=${EXTENSION_ID}`);
  const err = await page.evaluate(
    ([id, pattern]) =>
      new Promise<string>((done) => {
        const api = (globalThis as unknown as { chrome: { developerPrivate: { addHostPermission(id: string, host: string, cb: () => void): void }; runtime: { lastError?: { message?: string } } } }).chrome;
        api.developerPrivate.addHostPermission(id!, pattern!, () => done(api.runtime.lastError?.message ?? ""));
      }),
    [EXTENSION_ID, `${origin}/*`],
  );
  if (err) throw new Error(`grant host access: ${err}`);
  await page.close();
}

/** Open the panel page in its own popup window and wait for it to load. */
export async function openPanel(context: BrowserContext): Promise<Page> {
  const worker = context.serviceWorkers().find((w) => w.url().startsWith(EXTENSION_ORIGIN)) ?? (await context.waitForEvent("serviceworker"));
  const opened = context.waitForEvent("page", (p) => p.url().startsWith(`${EXTENSION_ORIGIN}/sidepanel.html`));
  await worker.evaluate(() => {
    const api = (globalThis as unknown as { chrome: { windows: { create(o: object): Promise<unknown> }; runtime: { getURL(p: string): string } } }).chrome;
    return api.windows.create({ url: api.runtime.getURL("sidepanel.html"), type: "popup", width: 420, height: 720 });
  });
  const panel = await opened;
  await panel.setViewportSize({ width: 400, height: 640 }); // the width of a side panel, not the profile's desktop viewport
  await panel.getByRole("heading", { name: "Convoz" }).waitFor();
  return panel;
}

/** Type the server address in the panel and save it, as the owner does on first open. */
export async function setServer(panel: Page, origin: string): Promise<void> {
  await panel.getByLabel("Convoz server").fill(origin);
  await panel.getByRole("button", { name: "Save" }).click();
}

/** A web page on an address of its own (served by the test), in a new tab, brought to the front. */
export async function openWebPage(context: BrowserContext, url: string, html: string): Promise<Page> {
  await context.route((u) => u.href === url, (route) => route.fulfill({ contentType: "text/html; charset=utf-8", body: html }));
  const page = await context.newPage();
  await page.goto(url);
  await page.bringToFront();
  return page;
}

/** The owner clicks the Convoz button in the toolbar while `page` is the active tab (see the note at the top). */
export async function clickConvozButton(context: BrowserContext, page: Page): Promise<void> {
  await page.bringToFront();
  const own = await context.newCDPSession(page);
  const { targetInfo } = await own.send("Target.getTargetInfo");
  await own.detach();
  const cdp = await context.browser()!.newBrowserCDPSession();
  try {
    await cdp.send("Extensions.triggerAction", { id: EXTENSION_ID, targetId: await tabOf(cdp, targetInfo.targetId) });
  } finally {
    await cdp.detach();
  }
}

/**
 * tabOf finds the tab target that holds the page target `pageId`: triggerAction takes a tab target, and a tab target names no
 * page. Each tab is asked for the page it holds; the old (non-flat) session API is used because Playwright's CDP session
 * cannot address a flat child session.
 */
async function tabOf(cdp: CDPSession, pageId: string): Promise<string> {
  const { targetInfos } = await cdp.send("Target.getTargets", { filter: [{ type: "tab" }] });
  for (const tab of targetInfos) {
    const { sessionId } = await cdp.send("Target.attachToTarget", { targetId: tab.targetId, flatten: false });
    try {
      const held = new Promise<string>((done) => {
        const onMessage = (e: { sessionId: string; message: string }) => {
          const msg = JSON.parse(e.message) as { method?: string; params?: { targetInfo?: { targetId: string } } };
          if (e.sessionId !== sessionId || msg.method !== "Target.attachedToTarget") return;
          cdp.off("Target.receivedMessageFromTarget", onMessage);
          done(msg.params!.targetInfo!.targetId);
        };
        cdp.on("Target.receivedMessageFromTarget", onMessage);
      });
      const ask = { id: 1, method: "Target.setAutoAttach", params: { autoAttach: true, waitForDebuggerOnStart: false, flatten: false } };
      await cdp.send("Target.sendMessageToTarget", { sessionId, message: JSON.stringify(ask) });
      if ((await held) === pageId) return tab.targetId;
    } finally {
      await cdp.send("Target.detachFromTarget", { sessionId });
    }
  }
  throw new Error(`no tab holds page target ${pageId}`);
}
