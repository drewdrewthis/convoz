// The offline shell (design §9). The build's files are precached; a page URL opens the app from the cache when the server is down
// or slow; API answers are never touched here (the page keeps its own copy in IndexedDB, which is the offline fallback), so nothing a
// route returns, a machine key above all, can land in Cache Storage (I-39). Only an app frame, immutable by its hash, is cached.
import { getCacheKeyForURL, matchPrecache, precache } from "workbox-precaching";
import { inDevScope } from "../shared/devScope.ts";
import type { SwModule } from "./module.ts";

declare const self: ServiceWorkerGlobalScope & { __WB_MANIFEST?: { url: string; revision: string | null }[] };

/** The shell page, fetched from the public /signin at install (vite.config.ts lists it). */
const SHELL = "/signin?shell=1";
/** A page URL that the server has not answered in this long opens from the cache: a slow link must not hold the first screen. */
const SERVER_WAIT_MS = 150;
const FRAMES = "convoz-frames";
const MAX_FRAMES = 40;

const pause = (ms: number) => new Promise<null>((resolve) => setTimeout(() => resolve(null), ms));

/**
 * slowLink says the server cannot answer a page URL in time: an answer takes at least one round trip, and the browser's estimate of
 * it (Network Information API) is already over the wait. Waiting would only hold the first screen. Unknown (no API): not slow.
 */
function slowLink(): boolean {
  const rtt = (navigator as WorkerNavigator & { connection?: { rtt?: number } }).connection?.rtt;
  return typeof rtt === "number" && rtt >= SERVER_WAIT_MS;
}

/**
 * lean asks the server for the lean shell of a page URL: the app's files by URL, which this worker holds, instead of the cold page that
 * carries them and the owner's first reads inline (design §12.2). A worker that has the files only needs the shell, and it is never
 * handed a page with user data in it (I-39). The request keeps its cookie and its manual redirects (the mode becomes same-origin).
 */
function lean(request: Request): Request {
  const headers = new Headers(request.headers);
  headers.set("X-Convoz-Shell", "lean");
  return new Request(request, { headers });
}

/** openApp answers a page URL: the server when it answers in time (sign-in redirects and the 404 page stay the server's), else the cached shell. */
async function openApp(request: Request): Promise<Response> {
  if (slowLink()) {
    const shell = await matchPrecache(SHELL);
    if (shell) return shell;
  }
  const network = fetch(lean(request));
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

/** The Static Routing API (Chromium): routes the browser applies itself, before (or instead of) waking the worker. */
type RoutingEvent = ExtendableEvent & { addRoutes?: (rules: { condition: unknown; source: "cache" | "network" }) => Promise<void> };
type Pattern = new (init: { pathname: string }) => unknown;

/**
 * serveFromCache asks the browser to answer the build's hashed files straight from the precache, without starting this script for
 * each one: on a slow phone every file of a warm start then arrives in a moment. Only hashed files (revision null: the name is the
 * version) are routed so; a file missing from the cache goes to the network. A browser without the API uses the fetch listener,
 * which gives the same answers.
 */
function serveFromCache(event: RoutingEvent, manifest: { url: string; revision: string | null }[]): void {
  const URLPatternOf = (globalThis as { URLPattern?: Pattern }).URLPattern;
  const hashed = manifest.filter((e) => e.revision === null && e.url.startsWith("/assets/"));
  if (!event.addRoutes || !URLPatternOf || !hashed.length) return;
  const condition = { or: hashed.map((e) => ({ urlPattern: new URLPatternOf({ pathname: e.url }) })) };
  event.waitUntil(event.addRoutes({ condition, source: "cache" }).catch((err) => console.warn("service worker routes:", err)));
}

const isFrame = (url: URL) => /^\/api\/apps\/[^/]+\/frame$/.test(url.pathname) && url.searchParams.has("h");

const cache: SwModule = {
  name: "cache",
  install(scope) {
    const manifest = self.__WB_MANIFEST ?? []; // the build replaces the first self.__WB_MANIFEST only (vite.config.ts)
    precache(manifest);
    scope.addEventListener("install", (event) => serveFromCache(event, manifest));
    scope.addEventListener("fetch", (event) => {
      const { request } = event;
      const url = new URL(request.url);
      if (url.origin !== scope.location.origin || request.method !== "GET") return;
      // The owner's dev build at /dev/ is never answered from the real app's cache: its pages and files go to the network.
      if (inDevScope(url.pathname)) return;
      if (request.mode === "navigate" && !url.pathname.startsWith("/api/")) return event.respondWith(openApp(request));
      if (isFrame(url)) return event.respondWith(cachedFrame(request));
      if (getCacheKeyForURL(request.url)) event.respondWith(matchPrecache(request).then((hit) => hit ?? fetch(request)));
    });
  },
};
export default cache;
