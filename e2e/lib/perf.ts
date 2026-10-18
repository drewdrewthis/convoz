import type { Browser, BrowserContext, CDPSession, Page } from "@playwright/test";

/*
 * Helpers of the client budget scenario (design §12.2, AC-10): a mid-range phone is the "mobile" project's 390 px touch window with
 * its CPU slowed 4 times, on one of two links by the browser's own network emulation.
 *   Fast-3G  Chrome DevTools' preset: 562.5 ms latency, 1.44 Mbit/s down, 675 kbit/s up.
 *   lossy    design §12.3, as in lib/wp17.ts and lib/event.ts: 400 ms latency, 400 kbit/s both ways.
 * The link is the page's and its service worker's: the worker fetches the page URL itself, so a link that only slowed the page would
 * let the worker reach the server at full speed. (CDP cannot slow a worker's CPU; the worker does little before the first screen.)
 * The time is the app's `tfus` mark (apps/web/src/shared/perf.ts), read from performance.getEntriesByName.
 */

export type Network = "Fast-3G" | "lossy";

export const NETWORKS: Record<Network, { latency: number; downloadThroughput: number; uploadThroughput: number }> = {
  "Fast-3G": { latency: 562.5, downloadThroughput: 180_000, uploadThroughput: 84_375 },
  lossy: { latency: 400, downloadThroughput: 50_000, uploadThroughput: 50_000 },
};

const PLAIN = { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 };

export interface Profile {
  /** Back to the plain link and CPU, so the set-up between two trials does not pay for the profile. */
  off(): Promise<void>;
}

/**
 * The phone profile on this page and on the service workers of `origin` that run now: CPU slowed 4 times and the given link. The page's
 * session keeps it across navigations. A worker is reached through the browser's session (Target.sendMessageToTarget: Playwright
 * opens sessions for pages and frames only).
 */
export async function phoneProfile(browser: Browser, context: BrowserContext, page: Page, network: Network, origin: string): Promise<Profile> {
  const cdp = await context.newCDPSession(page);
  await cdp.send("Network.enable");
  await cdp.send("Network.emulateNetworkConditions", { offline: false, ...NETWORKS[network] });
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  const workers = await workerLinks(browser, origin);
  await workers.set({ offline: false, ...NETWORKS[network] });
  return {
    off: async () => {
      await cdp.send("Network.emulateNetworkConditions", PLAIN);
      await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
      await cdp.detach();
      await workers.set(PLAIN);
      await workers.close();
    },
  };
}

/** The links of the service workers of `origin`, set by one call. */
async function workerLinks(browser: Browser, origin: string): Promise<{ set(conditions: object): Promise<void>; close(): Promise<void> }> {
  const b = await browser.newBrowserCDPSession();
  const { targetInfos } = await b.send("Target.getTargets");
  const sessions: string[] = [];
  for (const t of targetInfos.filter((t) => t.type === "service_worker" && t.url.startsWith(`${origin}/`))) {
    sessions.push((await b.send("Target.attachToTarget", { targetId: t.targetId, flatten: false })).sessionId);
  }
  let id = 0;
  const say = (sessionId: string, method: string, params: object) => b.send("Target.sendMessageToTarget", { sessionId, message: JSON.stringify({ id: ++id, method, params }) });
  for (const s of sessions) await say(s, "Network.enable", {});
  return {
    set: async (conditions) => {
      for (const s of sessions) await say(s, "Network.emulateNetworkConditions", conditions);
    },
    close: () => b.detach(),
  };
}

/** Everything the origin keeps but the session cookie: the service worker, Cache Storage, IndexedDB, and the HTTP cache. */
export async function emptyCache(cdp: CDPSession, origin: string): Promise<void> {
  await cdp.send("Storage.clearDataForOrigin", { origin, storageTypes: "service_workers,cache_storage,indexeddb,local_storage" });
  await cdp.send("Network.clearBrowserCache");
}

export interface Useful {
  /** The `tfus` mark, ms after the navigation started. */
  tfus: number;
  /** When the response of each API route the page asked for ended (ms after the navigation started), by path. */
  api: Record<string, number>;
  /** When the request of each of those routes started (ms after the navigation started), by path. */
  apiStart: Record<string, number>;
  /** When the page took each read its document carried inline (the app's "inline-read <path>" mark), by path. */
  inline: Record<string, number>;
  /**
   * The server's generated_at (wall clock, ms) of the document's data block, as the page's "inline-read" mark carries it (the page
   * removes the block from the DOM once read); null when the page took no inline read.
   */
  generatedAt: number | null;
  /** performance.timeOrigin: the wall clock (ms) of the navigation start, so a mark's time can meet the server's clock. */
  timeOrigin: number;
  /** When the document's response ended (ms after the navigation started). */
  documentEnd: number;
  /** The document's nextHopProtocol ("h2", "http/1.1"; "" when the service worker answered from its cache). */
  proto: string;
  /** The nextHopProtocol of every resource that came over the network. */
  resourceProtos: string[];
}

/** The median (the load the pass rule judges), the 90th percentile (nearest rank) and the worst of `values`. */
export function spread(values: number[]): { median: number; p90: number; worst: number } {
  const sorted = [...values].sort((a, b) => a - b);
  return { median: sorted[Math.floor(sorted.length / 2)]!, p90: sorted[Math.ceil(0.9 * sorted.length) - 1]!, worst: sorted[sorted.length - 1]! };
}

/**
 * Wait for the page's `tfus` mark; with it, when each API answer of the load ended (so a test can tell cache from network).
 * It polls with a plain evaluate on purpose: waitForFunction and locators first inject Playwright's own 300 KB script into the
 * page, which on a 4x slowed CPU holds the main thread for about 140 ms in the middle of the load being measured.
 */
export async function useful(page: Page, timeout: number): Promise<Useful> {
  const until = Date.now() + timeout;
  for (;;) {
    const got = await page
      .evaluate(() => {
        const mark = performance.getEntriesByName("tfus")[0];
        if (!mark) return null;
        const api: Record<string, number> = {};
        const apiStart: Record<string, number> = {};
        const resourceProtos: string[] = [];
        for (const e of performance.getEntriesByType("resource") as PerformanceResourceTiming[]) {
          const url = new URL(e.name);
          if (url.pathname.startsWith("/api/") && !(url.pathname in api)) {
            api[url.pathname] = e.responseEnd;
            apiStart[url.pathname] = e.startTime;
          }
          if (e.nextHopProtocol) resourceProtos.push(e.nextHopProtocol);
        }
        const inline: Record<string, number> = {};
        let generatedAt: number | null = null;
        for (const m of performance.getEntriesByType("mark") as PerformanceMark[]) {
          if (!m.name.startsWith("inline-read ")) continue;
          inline[m.name.slice("inline-read ".length)] = m.startTime;
          generatedAt ??= (m.detail as { generated_at?: number } | null)?.generated_at ?? null;
        }
        const [nav] = performance.getEntriesByType("navigation") as PerformanceNavigationTiming[];
        return { tfus: mark.startTime, api, apiStart, inline, generatedAt, timeOrigin: performance.timeOrigin, documentEnd: nav?.responseEnd ?? 0, proto: nav?.nextHopProtocol ?? "", resourceProtos };
      })
      .catch(() => null); // the document may still be on its way in
    if (got) return got;
    if (Date.now() > until) throw new Error(`no tfus mark within ${timeout} ms`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** How old a cold first screen's data may be at the `tfus` mark (the server's generated_at, or the request of its API answer). */
export const FRESH_MS = 5_000;

/**
 * firstScreenData says where a cold load's first screen got its data before the mark: "network" (its API answer ended before the
 * mark, asked for within FRESH_MS of it), "document" (the page took the read from its document's data block before the mark, the
 * document had ended by then, and the server made the block within FRESH_MS of it), or "none" with what was missing. A screen
 * marked before its data existed is "none".
 */
export function firstScreenData(load: Useful, path: string): string {
  const markAt = load.timeOrigin + load.tfus;
  const answered = load.api[path];
  if (answered !== undefined && answered <= load.tfus && load.apiStart[path]! >= load.tfus - FRESH_MS) return "network";
  const took = load.inline[path];
  if (took !== undefined && took <= load.tfus && load.documentEnd <= load.tfus && load.generatedAt !== null && load.generatedAt <= markAt && load.generatedAt >= markAt - FRESH_MS) return "document";
  return `none: ${path} answered at ${answered ?? "-"} (asked at ${load.apiStart[path] ?? "-"}), taken inline at ${took ?? "-"}, document ended at ${load.documentEnd.toFixed(0)}, generated ${load.generatedAt === null ? "-" : (markAt - load.generatedAt).toFixed(0) + " ms"} before the mark at ${load.tfus.toFixed(0)}`;
}
