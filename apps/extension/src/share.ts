// One shared tab (page-share.feature): the panel polls the server for the agents' requests and answers each from the tab, only
// while the tab is still there, in front in its window and on the site it was shared on. Otherwise it says "no shared tab" and the
// share ends: going back to the tab does not bring it back.
import { ApiFailure } from "./errors.ts";
import type { Convoz, PageRequest, PageResult } from "./api.ts";
import { collectPage, toRead } from "./page.ts";

/** What the owner shared: one tab, on one origin, with one conversation. */
export interface SharedTab {
  id: string;
  tabId: number;
  origin: string;
}

/** Why a share ended. */
export type Ended = "stopped" | "left" | "gone";

/** webOrigin is the origin of a page the extension may share (http or https), or null. */
export function webOrigin(url: string | undefined): string | null {
  try {
    const u = new URL(url ?? "");
    return u.protocol === "http:" || u.protocol === "https:" ? u.origin : null;
  } catch {
    return null;
  }
}

/** stillShared is the shared tab when it is still there, in front in its window and on its origin; null otherwise. */
async function stillShared(share: SharedTab): Promise<chrome.tabs.Tab | null> {
  const tab = await chrome.tabs.get(share.tabId).catch(() => null);
  return tab?.active && webOrigin(tab.url) === share.origin ? tab : null;
}

/** answer reads or screenshots the tab for one request. The error words are the extension's own, never the page's or Chrome's. */
async function answer(tab: chrome.tabs.Tab, req: PageRequest): Promise<PageResult> {
  if (req.op === "read") {
    try {
      const [done] = await chrome.scripting.executeScript({ target: { tabId: tab.id! }, func: collectPage });
      if (done?.result) return { ok: true, read: toRead(done.result) };
    } catch {
      // the page does not let extensions run scripts (a browser page, the Web Store)
    }
    return { ok: false, error: "This page cannot be read." };
  }
  try {
    const shot = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
    return { ok: true, shot: { png_base64: shot.slice(shot.indexOf(",") + 1) } };
  } catch {
    return { ok: false, error: "The screenshot could not be taken." };
  }
}

const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));

/**
 * runShare answers the agents' requests until the share ends: Stop (signal), the tab left (it answers "no shared tab" and ends the
 * share), or the server ended it (404: a newer share, a restart, the heartbeat). beat runs before each poll; the panel keeps the
 * worker awake with it, so the worker can end the share when the panel closes.
 */
export async function runShare(api: Convoz, share: SharedTab, signal: AbortSignal, beat: () => void): Promise<Ended> {
  while (!signal.aborted) {
    beat();
    let req: PageRequest | null;
    try {
      req = await api.next(share.id, signal);
    } catch (err) {
      if (signal.aborted) break;
      if (err instanceof ApiFailure && err.status === 404) return "gone";
      await pause(2000); // the server is out of reach for now; the share lives 45 s without a poll
      continue;
    }
    if (!req) continue;
    const tab = await stillShared(share);
    if (!tab) {
      await api.answer(req.id, { ok: false, error: "no shared tab" }).catch(() => {});
      await api.stopShare(share.id).catch(() => {});
      return "left";
    }
    await api.answer(req.id, await answer(tab, req)).catch(() => {});
  }
  return "stopped";
}
