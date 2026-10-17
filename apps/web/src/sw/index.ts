// The service worker registry, window side. The worker itself is worker.ts (built to /sw.js); each module of the worker is
// one file next to it (push.ts, cache.ts, ...) that worker.ts picks up on its own, so adding a module edits no shared file.

/** The worker's modules, found at build time. With none, no worker is registered and the app behaves as a plain page. */
const MODULES = Object.keys(import.meta.glob(["./*.ts", "!./index.ts", "!./worker.ts", "!./module.ts"]));

/**
 * registerServiceWorker installs /sw.js (scope /) once the page has loaded, when the build has worker modules and the
 * browser can run one. A failure is logged and never breaks the page: the app works without its worker.
 */
export function registerServiceWorker(): void {
  if (!MODULES.length || !("serviceWorker" in navigator)) return;
  addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js", { type: "module", scope: "/" }).catch((err) => console.warn("service worker:", err));
  });
}
