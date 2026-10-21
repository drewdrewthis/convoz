import type { BrowserContext, CDPSession, Page } from "@playwright/test";
import { expect } from "@playwright/test";
import { uiWorld, type UiWorld } from "./chat-ui.ts";
import type { ServerHandle, ServerOptions } from "./fixtures.ts";

/*
 * Helpers for the PWA and poor-network scenarios (WP17). The contract they lean on:
 *   - the service worker is /sw.js; it precaches the build, opens the app from the cache when the server does not answer in
 *     150 ms, never answers an /api route (so Cache Storage holds no API response), and a new build takes over and reloads the page by itself.
 *   - the offline copy is IndexedDB "convoz": stores `messages`, `conversations`, `me`, `outbox`, `meta` (syncedAt, now, cursor).
 *   - the banner "Offline · last synced <time>" (role status) shows while the link is down.
 */

export type Fx = { server: (o?: ServerOptions) => Promise<ServerHandle>; page: Page; context: BrowserContext };

/** The shape of the browser's emulated link while online: none, or the lossy profile of design §12.3. */
const LOSSY = { latency: 400, downloadThroughput: 50_000, uploadThroughput: 50_000 };

/** A page's own link, by CDP: it can go offline alone (a second page of the same context stays online), unlike `context.setOffline`. */
export async function pageLink(context: BrowserContext, page: Page, o: { lossy?: boolean } = {}): Promise<(offline: boolean) => Promise<void>> {
  const cdp: CDPSession = await context.newCDPSession(page);
  await cdp.send("Network.enable");
  const profile = o.lossy ? LOSSY : { latency: 0, downloadThroughput: -1, uploadThroughput: -1 };
  return (offline) => cdp.send("Network.emulateNetworkConditions", { offline, ...profile }) as Promise<void>;
}

/** The owner's world with the browser signed in (Background of the poor-network file). */
export const world = (fx: Fx): Promise<UiWorld> => uiWorld(fx);

/** Wait until the service worker controls this page: the app is "installed" and can open offline. */
export async function installed(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) await new Promise<void>((resolve) => navigator.serviceWorker.addEventListener("controllerchange", () => resolve(), { once: true }));
  });
}

export interface Stored {
  messages: Record<number, number>;
  conversations: number;
  me: number;
  outbox: number;
  meta: string[];
}

/** What the offline copy holds right now, read from IndexedDB without opening a second version of it. */
export function stored(page: Page): Promise<Stored | null> {
  return page.evaluate(async () => {
    if (!(await indexedDB.databases()).some((d) => d.name === "convoz")) return null;
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const open = indexedDB.open("convoz");
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
    const all = <T>(store: string): Promise<T[]> =>
      new Promise((resolve, reject) => {
        const req = db.transaction(store).objectStore(store).getAll();
        req.onsuccess = () => resolve(req.result as T[]);
        req.onerror = () => reject(req.error);
      });
    const keys = (store: string): Promise<string[]> =>
      new Promise((resolve, reject) => {
        const req = db.transaction(store).objectStore(store).getAllKeys();
        req.onsuccess = () => resolve(req.result as string[]);
        req.onerror = () => reject(req.error);
      });
    try {
      const messages: Record<number, number> = {};
      for (const m of await all<{ conversation_id: number }>("messages")) messages[m.conversation_id] = (messages[m.conversation_id] ?? 0) + 1;
      return { messages, conversations: (await all("conversations")).length, me: (await all("me")).length, outbox: (await all("outbox")).length, meta: await keys("meta") };
    } finally {
      db.close();
    }
  });
}

/** Wait for the offline copy to hold at least `count` messages of a conversation (writes are batched 150 ms behind the cache). */
export async function cachedMessages(page: Page, conv: number, count: number): Promise<void> {
  await expect.poll(async () => (await stored(page))?.messages[conv] ?? 0, { timeout: 30_000, message: `conversation ${conv} cached` }).toBeGreaterThanOrEqual(count);
}

/** The Cache Storage entries of the page's origin: every cache with the URLs it holds. */
export function cacheUrls(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const out: string[] = [];
    for (const name of await caches.keys()) for (const req of await (await caches.open(name)).keys()) out.push(new URL(req.url).pathname + new URL(req.url).search);
    return out;
  });
}
