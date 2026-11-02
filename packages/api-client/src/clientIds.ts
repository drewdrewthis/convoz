// The two ids the server's access log tells browser tabs apart by (apps/convoz httpapi/accesslog.go). Each is 8 random hex digits
// and nothing else: no person, no device, no time. The server logs one only when it is exactly that shape.
//   X-Convoz-Tab: one per browser tab, kept in sessionStorage, so a reload keeps it (and a duplicated tab copies it).
//   X-Convoz-Load: one per page load, kept in memory only.
// Where sessionStorage is refused (a private mode, a sandboxed frame, a worker) the tab id lives in memory: a reload then looks like a new tab.

const TAB_KEY = "convoz.tab";
const ID = /^[0-9a-f]{8}$/;

/** randomId is 8 hex digits from crypto.getRandomValues. */
export function randomId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(4)), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** tabIdFrom reads this tab's id from `storage`, or makes one and keeps it there. Any storage failure gives a fresh id, kept in memory. */
export function tabIdFrom(storage: () => Storage): string {
  try {
    const store = storage();
    const held = store.getItem(TAB_KEY);
    if (held !== null && ID.test(held)) return held;
    const made = randomId();
    store.setItem(TAB_KEY, made);
    return made;
  } catch {
    return randomId();
  }
}

let ids: { tab: string; load: string } | undefined;

/** clientIdHeaders are the two headers of this page load, made on first use. */
export function clientIdHeaders(): { "X-Convoz-Tab": string; "X-Convoz-Load": string } {
  ids ??= { tab: tabIdFrom(() => globalThis.sessionStorage), load: randomId() };
  return { "X-Convoz-Tab": ids.tab, "X-Convoz-Load": ids.load };
}
