// Uncaught errors of the page go to the server's own log (POST /api/client-errors), so the owner can read them in journalctl.
// No third party. The report holds the error's message and stack, the page's path (never its query), the build and the browser;
// nothing else of the page, no conversation content, no token. The service worker has its own copy (sw/errors.ts): it cannot import this.

declare const __BUILD__: string;

const MAX_REPORTS = 10; // per page load
const MAX_MESSAGE = 500;
const MAX_STACK = 4096;
const sent = new Set<string>();

/** scrub drops what must not leave the page: the query of a URL, and any long token-like run (a key, a ticket, a session id). */
export function scrub(text: string): string {
  return text.replace(/(https?:\/\/[^\s?#)]*)[?#][^\s)]*/g, "$1").replace(/[A-Za-z0-9_-]{32,}/g, "[redacted]");
}

/** reportError sends one error to the server: repeats of the same error and everything past the tenth of a page load are dropped. */
export function reportError(error: unknown): void {
  const e = error instanceof Error ? error : new Error(String(error));
  const message = scrub(e.message).slice(0, MAX_MESSAGE);
  const stack = scrub(e.stack ?? "").slice(0, MAX_STACK);
  const key = message + stack;
  if (sent.has(key) || sent.size >= MAX_REPORTS) return;
  sent.add(key);
  const body = { message, stack, page: location.pathname, build: __BUILD__, ua: navigator.userAgent, at: Date.now() };
  // fetch with keepalive, not sendBeacon: the server's CSRF check needs the X-Convoz header, which a beacon cannot carry.
  fetch("/api/client-errors", { method: "POST", keepalive: true, headers: { "Content-Type": "application/json", "X-Convoz": "1" }, body: JSON.stringify(body) }).catch(() => {});
}

/** watchErrors reports every uncaught error and unhandled rejection of the page. */
export function watchErrors(): void {
  addEventListener("error", (event) => reportError(event.error ?? event.message));
  addEventListener("unhandledrejection", (event) => reportError(event.reason));
}
