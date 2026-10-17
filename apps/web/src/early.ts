// The head start of a page load (design §12.2). This script is tiny and imports nothing, so the browser runs it as soon as it
// arrives, while the main bundle is still on its way. It asks at once for what the first screen of this URL waits on: its API
// reads, and its page's chunk (listed by the build in <meta name="convoz-pages">). On a slow link those waits then overlap the
// download of the bundle instead of following it. The app's client takes each answer once (shared/early.ts).

/**
 * The reads each first screen makes as soon as it shows. They are the client's own requests (same headers, same cookie), so the
 * answer the client is handed is the one it would have fetched itself.
 */
const READS: Record<string, string[]> = {
  "/": ["/api/now", "/api/me"],
  "/chats": ["/api/me", "/api/conversations"],
};

const HEADERS = { "Content-Type": "application/json", "X-Convoz": "1" };

const path = location.pathname;
const early = new Map<string, Promise<Response>>();
for (const read of READS[path] ?? []) {
  const url = new URL(read, location.origin).href;
  const answer = fetch(url, { credentials: "same-origin", headers: HEADERS });
  answer.catch(() => {}); // a failed head start is retried by the client itself
  early.set(url, answer);
}
(globalThis as { convozEarly?: Map<string, Promise<Response>> }).convozEarly = early;

let pages: Record<string, string[]> = {};
try {
  pages = JSON.parse(document.querySelector<HTMLMetaElement>('meta[name="convoz-pages"]')?.content || "{}");
} catch {
  /* a build without the list only loses the head start */
}
const page = path in pages ? path : /^\/chats\/[^/]+$/.test(path) ? "/chats/:id" : path;
for (const href of pages[page] ?? []) {
  const link = document.createElement("link");
  link.rel = "modulepreload";
  link.crossOrigin = "";
  link.href = href;
  document.head.append(link);
}
