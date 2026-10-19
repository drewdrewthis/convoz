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
    if (!worker || !navigator.serviceWorker.controller) return;
    useUpdate.setState({ ready: true });
    // A page the owner is looking at keeps its bar; only a page out of sight takes the update at once.
    if (document.visibilityState === "hidden") applyWhenHidden();
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

/** The worker's registration; it registers /sw.js (scope /) when there is none yet, so a caller never waits on a worker nobody installed. */
export function ensureServiceWorker(): Promise<ServiceWorkerRegistration> {
  return navigator.serviceWorker.getRegistration("/").then((held) => held ?? navigator.serviceWorker.register("/sw.js", { type: "module", scope: "/" }));
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
  // A page that is already loaded when this runs (a Home Screen app resumed, a late module) never gets a "load" event again.
  const start = () => {
    // An existing registration is kept and asked to look for a new build; only the first visit registers.
    ensureServiceWorker()
      .then((reg) => {
        registration = reg;
        watch(reg);
        claimLoosePage();
        void reg.update().catch(() => {});
      })
      .catch((err) => console.warn("service worker:", err));
  };
  if (document.readyState === "complete") start();
  else addEventListener("load", start);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") return applyWhenHidden();
    // The look for a new build finishes first: a hand-over started in the middle of it can stall.
    void Promise.resolve(registration?.update()).catch(() => {}).then(applyWhenSafe);
  });
}

/** Unsent text in any field of the page. Composer text lives only in component state (it is not saved), so a reload would lose it. */
function halfWritten(): boolean {
  const fields = document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("textarea, input:not([type=checkbox],[type=radio],[type=button],[type=submit],[type=hidden],[type=file])");
  return [...fields].some((f) => f.value.trim() !== "") || !!document.querySelector("[contenteditable=true]:not(:empty)");
}

/** The worker that applyWhenSafe already applied: one try per waiting worker, so a failed hand-over never loops. */
let tried: ServiceWorker | null | undefined;

/**
 * applyWhenSafe applies a waiting update by itself, while the app is in the background or when it comes back to the screen, but
 * only with nothing half-written. Otherwise the "Update ready" bar stays for the owner's tap.
 */
function applyWhenSafe(): void {
  const waiting = registration?.waiting;
  if (!waiting || waiting === tried || !navigator.serviceWorker.controller) return;
  if (halfWritten()) return; // hidden too: on a phone the owner often switches apps in the middle of a message
  tried = waiting;
  applyUpdate();
}

/** A page that hides while it unloads (a reload, a link) must not apply the update, so the page has to stay hidden for a moment first. */
function applyWhenHidden(): void {
  setTimeout(() => document.visibilityState === "hidden" && applyWhenSafe(), 500);
}

/**
 * applyUpdate lets the waiting worker take over and reloads the page under it. The bar's Reload button calls it, and
 * applyWhenSafe calls it when no reload can cost the owner a half-written message.
 */
export function applyUpdate(): void {
  const waiting = registration?.waiting;
  if (!waiting) return;
  navigator.serviceWorker.addEventListener("controllerchange", () => location.reload(), { once: true });
  waiting.postMessage({ type: "skip-waiting" });
}
