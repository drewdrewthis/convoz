// The service worker registry, window side. The worker itself is worker.ts (built to /sw.js); each module of the worker is
// one file next to it (cache.ts, push.ts, ...) that worker.ts picks up on its own, so adding a module edits no shared file.
/** The worker's modules, found at build time. With none, no worker is registered and the app behaves as a plain page. */
const MODULES = Object.keys(import.meta.glob(["./*.ts", "!./index.ts", "!./worker.ts", "!./module.ts"]));

let registration: ServiceWorkerRegistration | undefined;

/** When this tab last reloaded for a new build: a second hand-over within this time is not followed by a reload, so a fault never loops. */
const RELOADED_AT = "convoz.sw.reloaded_at";
const RELOAD_GAP_MS = 10_000;

/**
 * reloadOnUpdate reloads the page once a new build's worker takes it over (worker.ts skips waiting), so the page never runs half on old
 * code. The first worker claiming a page that had none replaces nothing and reloads nothing. The message box keeps its text through the
 * reload (features/composer/draft.ts).
 */
function reloadOnUpdate(): void {
  let controlled = Boolean(navigator.serviceWorker.controller);
  let reloading = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (!controlled) return void (controlled = true);
    if (reloading) return;
    const last = Number(sessionStorage.getItem(RELOADED_AT) ?? 0);
    if (Date.now() - last < RELOAD_GAP_MS) return;
    reloading = true;
    sessionStorage.setItem(RELOADED_AT, String(Date.now()));
    location.reload();
  });
}

/**
 * claimLoosePage: the first worker claims the open pages when it activates, but a page that was still loading then is missed and
 * stays outside the worker (no update, no controllerchange) until its next load. Such a page asks the worker to claim it.
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
 * build at each start and whenever the app comes back to the screen; a new build takes over and reloads the page by itself.
 */
export function registerServiceWorker(): void {
  if (!MODULES.length || !("serviceWorker" in navigator)) return;
  // Signing out cleared the device (Clear-Site-Data): a worker installed now would fill Cache Storage again at once.
  if (new URLSearchParams(location.search).has("signed_out")) return;
  reloadOnUpdate();
  // A page that is already loaded when this runs (a Home Screen app resumed, a late module) never gets a "load" event again.
  const start = () => {
    // An existing registration is kept and asked to look for a new build; only the first visit registers.
    ensureServiceWorker()
      .then((reg) => {
        registration = reg;
        claimLoosePage();
        void reg.update().catch(() => {});
      })
      .catch((err) => console.warn("service worker:", err));
  };
  if (document.readyState === "complete") start();
  else addEventListener("load", start);
  // A Home Screen app resumed from the background never loads again: coming back to the screen is when it looks for a new build.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void registration?.update().catch(() => {});
  });
}
