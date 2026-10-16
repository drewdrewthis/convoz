import type { BrowserContext, Page } from "@playwright/test";

/**
 * The ceremony-per-tap guard (S-U0). iOS Safari allows one WebAuthn ceremony per user activation, and only while the
 * activation is fresh. So every tap must start at most one ceremony, and no network call may sit between the tap and
 * the ceremony (the options are fetched before the tap).
 *
 * It wraps navigator.credentials.get/create in every page of the context and watches trusted clicks and fetch():
 *   - a ceremony started by a tap that already started a ceremony        -> "second ceremony in one tap"
 *   - a ceremony started after a fetch() that the same tap started       -> "network call between tap and ceremony"
 *   - a ceremony that no tap started                                    -> "ceremony without a tap"
 * Violations and ceremonies are reported to Node through an exposed function, so they survive page navigations.
 */
export interface Ceremony {
  kind: "get" | "create";
  path: string;
}

export interface CeremonyGuard {
  /** Every violation seen so far, as text. Empty when every tap was clean. */
  violations(): string[];
  /** Every WebAuthn ceremony started so far, in order. */
  ceremonies(): Ceremony[];
  /** Make the next ceremony on `page` fail the way a closed or timed-out prompt does (a real DOMException). */
  rejectNext(page: Page, name: "NotAllowedError" | "AbortError"): Promise<void>;
}

const INIT = `(() => {
  if (window.__cvzGuard || !navigator.credentials) return;
  window.__cvzGuard = true;
  let tap = null;
  window.addEventListener("click", (e) => { if (e.isTrusted) tap = { fetches: 0, ceremonies: 0 }; }, true);
  const nativeFetch = window.fetch;
  window.fetch = function (...args) {
    if (tap && tap.ceremonies === 0) tap.fetches++;
    return nativeFetch.apply(this, args);
  };
  for (const kind of ["get", "create"]) {
    const native = navigator.credentials[kind].bind(navigator.credentials);
    navigator.credentials[kind] = function (options) {
      if (options && options.publicKey) {
        const path = location.pathname;
        window.__cvzGuardReport({ ceremony: { kind, path } });
        if (!tap) window.__cvzGuardReport({ violation: "ceremony without a tap on " + path });
        else {
          tap.ceremonies++;
          if (tap.ceremonies > 1) window.__cvzGuardReport({ violation: "second ceremony in one tap on " + path });
          if (tap.fetches > 0) window.__cvzGuardReport({ violation: "network call between tap and ceremony on " + path });
        }
        if (window.__cvzRejectNext) {
          const name = window.__cvzRejectNext;
          window.__cvzRejectNext = null;
          return Promise.reject(new DOMException("The operation either timed out or was not allowed.", name));
        }
      }
      return native(options);
    };
  }
})();`;

const guards = new WeakMap<BrowserContext, CeremonyGuard>();

/** Install the guard on a context (once) and return it. */
export async function installCeremonyGuard(context: BrowserContext): Promise<CeremonyGuard> {
  const known = guards.get(context);
  if (known) return known;
  const violations: string[] = [];
  const ceremonies: Ceremony[] = [];
  await context.exposeFunction("__cvzGuardReport", (r: { ceremony?: Ceremony; violation?: string }) => {
    if (r.ceremony) ceremonies.push(r.ceremony);
    if (r.violation) violations.push(r.violation);
  });
  await context.addInitScript(INIT);
  const guard: CeremonyGuard = {
    violations: () => [...violations],
    ceremonies: () => [...ceremonies],
    rejectNext: async (page, name) => {
      await page.evaluate((n) => {
        (window as unknown as { __cvzRejectNext: string }).__cvzRejectNext = n;
      }, name);
    },
  };
  guards.set(context, guard);
  return guard;
}

export function guardOf(context: BrowserContext): CeremonyGuard | undefined {
  return guards.get(context);
}
