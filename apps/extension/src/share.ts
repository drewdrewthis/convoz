// One shared tab (page-share.feature): the panel polls the server for the agents' requests and answers each from the tab, while the
// tab is still there and on the site it was shared on. The owner may look at other tabs meanwhile: a read works on a tab behind
// another, and a screenshot, which Chrome takes of the tab in front only, says "tab not in front". A closed tab or one on another site
// says "no shared tab" and the share ends: going back does not bring it back. The panel also ends it the moment the tab changes
// (checkShared on each tab event), so no agent has to ask first.
import { ApiFailure } from "./errors.ts";
import type { Convoz, PageRequest, PageResult } from "./api.ts";
import { collectPage, toRead } from "./page.ts";

/** What the owner shared: one tab, on one origin, with one conversation. */
export interface SharedTab {
  id: string;
  tabId: number;
  origin: string;
}

/** Why a share ended: the owner's Stop, the tab closed, the tab went to another site, or the server ended it. */
export type Ended = "stopped" | "tabClosed" | "otherSite" | "gone";

/** endedText is what the panel says when a share ends: the exact reason, in the owner's words. */
export function endedText(ended: Ended, host: string): string {
  switch (ended) {
    case "stopped":
      return "Sharing stopped.";
    case "tabClosed":
      return "Sharing ended: the shared tab was closed.";
    case "otherSite":
      return `Sharing ended: the shared tab left ${host}.`;
    case "gone":
      return "Sharing ended: Convoz ended it (a newer share, a restart, or no contact for 45 seconds).";
  }
}

/** The extension's answer to a screenshot of a shared tab behind another tab; the server tells the agent to ask the owner. */
export const NOT_IN_FRONT = "tab not in front";

/** webOrigin is the origin of a page the extension may share (http or https), or null. */
export function webOrigin(url: string | undefined): string | null {
  try {
    const u = new URL(url ?? "");
    return u.protocol === "http:" || u.protocol === "https:" ? u.origin : null;
  } catch {
    return null;
  }
}

/**
 * checkShared is the shared tab while it is there and on its origin, in front or not; else why the share ends. A tab on a site the
 * extension has no access to shows no address, so it is not on its origin.
 */
export async function checkShared(share: SharedTab): Promise<{ tab: chrome.tabs.Tab } | { ended: "tabClosed" | "otherSite" }> {
  const tab = await chrome.tabs.get(share.tabId).catch(() => null);
  if (!tab) return { ended: "tabClosed" };
  return webOrigin(tab.url) === share.origin ? { tab } : { ended: "otherSite" };
}

/** answer reads or screenshots the tab for one request. The error words are the extension's own, never the page's or Chrome's. */
export async function answer(tab: chrome.tabs.Tab, req: PageRequest): Promise<PageResult> {
  if (req.op === "read") {
    try {
      const [done] = await chrome.scripting.executeScript({ target: { tabId: tab.id! }, func: collectPage });
      if (done?.result) return { ok: true, read: toRead(done.result) };
    } catch {
      // the page does not let extensions run scripts (a browser page, the Web Store)
    }
    return { ok: false, error: "This page cannot be read." };
  }
  // Chrome captures the tab in front of the window: of a tab behind another it would send the wrong page
  if (!tab.active) return { ok: false, error: NOT_IN_FRONT };
  try {
    const shot = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
    return { ok: true, shot: { png_base64: shot.slice(shot.indexOf(",") + 1) } };
  } catch {
    return { ok: false, error: "The screenshot could not be taken." };
  }
}

const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));

/**
 * runShare answers the agents' requests until the share ends: Stop (signal), the tab closed or left its site (it answers "no shared
 * tab" and ends the share), or the server ended it (404: a newer share, a restart, the heartbeat). beat runs before each poll; the panel keeps the
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
    const now = await checkShared(share);
    if ("ended" in now) {
      await api.answer(req.id, { ok: false, error: "no shared tab" }).catch(() => {});
      await api.stopShare(share.id, "left").catch(() => {});
      return now.ended;
    }
    await api.answer(req.id, await answer(now.tab, req)).catch(() => {});
  }
  return "stopped";
}
