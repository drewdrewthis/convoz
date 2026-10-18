// The service worker registry, window side. The worker itself is worker.ts (built to /sw.js); each module of the worker is
// one file next to it (cache.ts, update.ts, ...) that worker.ts picks up on its own, so adding a module edits no shared file.
import { create } from "zustand";

/** The worker's modules, found at build time. With none, no worker is registered and the app behaves as a plain page. */
const MODULES = Object.keys(import.meta.glob(["./*.ts", "!./index.ts", "!./worker.ts", "!./module.ts"]));

/** updateReady is true while a new build's worker waits for the owner's tap. */
export const useUpdate = create<{ ready: boolean }>()(() => ({ ready: false }));

let registration: ServiceWorkerRegistration | undefined;

/** A worker that waits while another controls the page is an update; the first worker never waits. */
function watch(reg: ServiceWorkerRegistration): void {
  const check = (worker: ServiceWorker | null) => {
    if (worker && navigator.serviceWorker.controller) useUpdate.setState({ ready: true });
  };
  check(reg.waiting);
  reg.addEventListener("updatefound", () => {
    const next = reg.installing;
    next?.addEventListener("statechange", () => next.state === "installed" && check(next));
  });
}

/**
 * claimLoosePage: the first worker claims the open pages when it activates, but a page that was still loading then is missed and
 * stays outside the worker (no update toast, no controllerchange) until its next load. Such a page asks the worker to claim it.
 */
function claimLoosePage(): void {
  void navigator.serviceWorker.ready.then(({ active }) => {
    if (!navigator.serviceWorker.controller) active?.postMessage({ type: "claim" });
  });
}

/**
 * registerServiceWorker installs /sw.js (scope /) once the page has loaded, when the build has worker modules and the
 * browser can run one. A failure is logged and never breaks the page: the app works without its worker. It looks for a new
 * build whenever the app comes back to the screen.
 */
export function registerServiceWorker(): void {
  if (!MODULES.length || !("serviceWorker" in navigator)) return;
  // Signing out cleared the device (Clear-Site-Data): a worker installed now would fill Cache Storage again at once.
  if (new URLSearchParams(location.search).has("signed_out")) return;
  addEventListener("load", () => {
    // An existing registration is kept and asked to look for a new build; only the first visit registers.
    navigator.serviceWorker
      .getRegistration("/")
      .then((held) => held ?? navigator.serviceWorker.register("/sw.js", { type: "module", scope: "/" }))
      .then((reg) => {
        registration = reg;
        watch(reg);
        claimLoosePage();
        void reg.update().catch(() => {});
      })
      .catch((err) => console.warn("service worker:", err));
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void registration?.update().catch(() => {});
  });
}

/**
 * applyUpdate lets the waiting worker take over and reloads the page under it. Nothing changes until it is called, so the
 * owner chooses the moment (a half-written message is not lost to a surprise reload).
 */
export function applyUpdate(): void {
  const waiting = registration?.waiting;
  if (!waiting) return;
  navigator.serviceWorker.addEventListener("controllerchange", () => location.reload(), { once: true });
  waiting.postMessage({ type: "skip-waiting" });
}
