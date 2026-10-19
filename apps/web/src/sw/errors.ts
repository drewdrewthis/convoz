// Errors in the worker go to the server's log like the page's (shared/clientErrors.ts; the worker cannot import it, so this is a
// small copy). Message and stack only, with query strings and token-like runs removed.
import type { SwModule } from "./module.ts";

declare const __BUILD__: string;

const MAX_REPORTS = 10; // per worker start
const sent = new Set<string>();

const scrub = (text: string): string => text.replace(/(https?:\/\/[^\s?#)]*)[?#][^\s)]*/g, "$1").replace(/[A-Za-z0-9_-]{32,}/g, "[redacted]");

const errors: SwModule = {
  name: "errors",
  install(scope) {
    const report = (error: unknown, event?: ExtendableEvent) => {
      const e = error instanceof Error ? error : new Error(String(error));
      const message = scrub(e.message).slice(0, 500);
      const stack = scrub(e.stack ?? "").slice(0, 4096);
      if (sent.has(message + stack) || sent.size >= MAX_REPORTS) return;
      sent.add(message + stack);
      const body = { message, stack, page: "/sw.js", build: __BUILD__, ua: scope.navigator.userAgent, at: Date.now() };
      const send = fetch("/api/client-errors", { method: "POST", keepalive: true, headers: { "Content-Type": "application/json", "X-Convoz": "1" }, body: JSON.stringify(body) }).catch(() => {});
      event?.waitUntil(send);
    };
    scope.addEventListener("error", (event) => report(event.error ?? event.message));
    scope.addEventListener("unhandledrejection", (event) => report(event.reason));
  },
};
export default errors;
