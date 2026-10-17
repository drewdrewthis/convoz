import type { BrowserContext, CDPSession, Page } from "@playwright/test";
import type { ServerHandle } from "./fixtures.ts";
import { send } from "./http.ts";
import { must, type Owner } from "./owner.ts";
import { postWith, setEngine, uploadWhole, wav } from "./uploads-wp10.ts";

/**
 * Helpers of the bindings that closed the scenarios the earlier work packages left open (tests/*.bind.spec.ts).
 * The fake transcription engine takes an extra `delay_ms` on POST /__test/transcriber: it is counted on the server clock, so a
 * scenario that says "the engine takes 30 seconds" moves the test clock instead of waiting.
 */

/** Turn the fake engine on for the workspace and script what it answers: the words, a failure, a delay on the server clock. */
export async function scriptEngine(who: { srv: ServerHandle; owner: Owner }, o: { text: string; fail?: boolean; delayMs?: number }): Promise<void> {
  await setEngine(who, "fake", o.text);
  must(await send(who.srv.target, "POST", "/__test/transcriber", { json: { text: o.text, fail: o.fail ?? false, delay_ms: o.delayMs ?? 0 } }), "script the fake engine");
}

/** The owner sends a voice note of `seconds` in a conversation, by the API. Returns the message id. */
export async function ownerSendsVoice(who: { srv: ServerHandle; owner: Owner }, conv: number, seconds = 3): Promise<number> {
  const up = await uploadWhole(who, conv, "audio", "voice-note.wav", wav(seconds), 600_000, { "Upload-Duration-Ms": String(seconds * 1000) });
  return Number(must(await postWith(who, conv, "", [up.id]), "voice message", 201).json().id);
}

// ---- the browser's idea of its network ------------------------------------------------------------------------------

/** What `navigator.connection` reports: a type ("4g", "3g"), or `null` for a browser with no such API (iOS Safari). */
export interface Reported {
  type: string | null;
  saveData?: boolean;
}

/**
 * Let a scenario say what the browser reports about its link. The report is read from this tab's sessionStorage at every page load,
 * so `reportNetwork` changes it for the next navigation of the same tab. Call once per context, before the first navigation.
 */
export async function installNetworkReport(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    let raw: string | null = null;
    try {
      raw = sessionStorage.getItem("__reported_network");
    } catch {
      return;
    }
    if (!raw) return;
    const net = JSON.parse(raw) as { type: string | null; saveData?: boolean };
    const value = net.type === null ? undefined : { effectiveType: net.type, saveData: Boolean(net.saveData), addEventListener() {}, removeEventListener() {} };
    Object.defineProperty(navigator, "connection", { value, configurable: true });
  });
}

/** Set what the next page load of this tab reports (the page must be on the app's origin already). */
export function reportNetwork(page: Page, net: Reported): Promise<void> {
  return page.evaluate((n) => sessionStorage.setItem("__reported_network", JSON.stringify(n)), net);
}

const sessions = new WeakMap<Page, CDPSession>();

/**
 * Add `ms` of round-trip delay to everything this page does, by the browser's own network emulation, and turn the HTTP cache off so
 * a file that an earlier page load fetched is fetched (and logged) again.
 */
export async function addLatency(context: BrowserContext, page: Page, ms: number): Promise<void> {
  // one session per page: a second session's emulation does not replace the first one's
  let cdp = sessions.get(page);
  if (!cdp) {
    cdp = await context.newCDPSession(page);
    sessions.set(page, cdp);
    await cdp.send("Network.enable");
  }
  await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
  await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: ms, downloadThroughput: -1, uploadThroughput: -1 });
}
