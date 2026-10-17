// The offline shell (design §9). The build's files are precached; a page URL opens the app from the cache when the server is down
// or slow; API answers are never touched here (the page keeps its own copy in IndexedDB, which is the offline fallback), so nothing a
// route returns, a machine key above all, can land in Cache Storage (I-39). Only an app frame, immutable by its hash, is cached.
import { getCacheKeyForURL, matchPrecache, precache } from "workbox-precaching";
import type { SwModule } from "./module.ts";

declare const self: ServiceWorkerGlobalScope & { __WB_MANIFEST?: { url: string; revision: string | null }[] };

/** The shell page, fetched from the public /signin at install (vite.config.ts lists it). */
const SHELL = "/signin?shell=1";
/** A page URL that the server has not answered in this long opens from the cache: a slow link must not hold the first screen. */
const SERVER_WAIT_MS = 150;
const FRAMES = "convoz-frames";
const MAX_FRAMES = 40;

const pause = (ms: number) => new Promise<null>((resolve) => setTimeout(() => resolve(null), ms));

/** openApp answers a page URL: the server when it answers in time (sign-in redirects and the 404 page stay the server's), else the cached shell. */
async function openApp(request: Request): Promise<Response> {
  const network = fetch(request);
  network.catch(() => {}); // when the shell answers first, a later failure is nobody's news
  const quick = await Promise.race([network.catch(() => null), pause(SERVER_WAIT_MS)]);
  return quick ?? (await matchPrecache(SHELL)) ?? network;
}

/** cachedFrame is cache-first: an app frame is addressed by the hash of its content, so a stored one is never stale. */
async function cachedFrame(request: Request): Promise<Response> {
  const cache = await caches.open(FRAMES);
  const hit = await cache.match(request);
  if (hit) return hit;
  const response = await fetch(request);
  if (response.ok && !/no-store/.test(response.headers.get("Cache-Control") ?? "")) {
    await cache.put(request, response.clone());
    const keys = await cache.keys();
    await Promise.all(keys.slice(0, Math.max(0, keys.length - MAX_FRAMES)).map((key) => cache.delete(key)));
  }
  return response;
}

const isFrame = (url: URL) => /^\/api\/apps\/[^/]+\/frame$/.test(url.pathname) && url.searchParams.has("h");

const cache: SwModule = {
  name: "cache",
  install(scope) {
    precache(self.__WB_MANIFEST ?? []);
    scope.addEventListener("fetch", (event) => {
      const { request } = event;
      const url = new URL(request.url);
      if (url.origin !== scope.location.origin || request.method !== "GET") return;
      if (request.mode === "navigate" && !url.pathname.startsWith("/api/")) return event.respondWith(openApp(request));
      if (isFrame(url)) return event.respondWith(cachedFrame(request));
      if (getCacheKeyForURL(request.url)) event.respondWith(matchPrecache(request).then((hit) => hit ?? fetch(request)));
    });
  },
};
export default cache;
