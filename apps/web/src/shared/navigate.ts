// In-app navigation. Pages are still separate documents when a link or the server brings the browser to them; the few actions that
// stay in the app (Now's "Reply in thread", a row of "You replied", "Reply" on the digest) go through navigate: the history entry is
// pushed, the app draws the page of the new path (app/Root.tsx), and no document loads, so the stores and the stream stay as they are.
import { useSyncExternalStore, type MouseEvent } from "react";

const listeners = new Set<() => void>();
const emit = () => listeners.forEach((f) => f());
// Back and Forward between entries this app pushed.
addEventListener("popstate", emit);

/** True once this page pushed an entry itself: Back then goes to the page that was left, not out of the app. */
let pushed = false;
export const navigatedInApp = () => pushed;

/** navigate goes to a path of the app. A link to another place on the open page only moves the hash, which the page follows by itself. */
export function navigate(to: string): void {
  const url = new URL(to, location.href);
  if (url.pathname === location.pathname) {
    location.hash = url.hash;
    return;
  }
  history.pushState(null, "", url.pathname + url.search + url.hash);
  pushed = true;
  emit();
}

/** visit is the onClick of a link that stays in the app. A click that asks for a new tab or window keeps the link's own behaviour. */
export function visit(event: MouseEvent<HTMLElement>, to: string): void {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  navigate(to);
}

/** usePath is the path of the open page, which moves with navigate and with Back and Forward. */
export function usePath(): string {
  return useSyncExternalStore(
    (notify) => {
      listeners.add(notify);
      return () => void listeners.delete(notify);
    },
    () => location.pathname,
  );
}
