// Pull to refresh on a touch screen. Every list scrolls in its own box (overscroll-behavior: contain) and an installed iPhone app has
// no browser pull-down at all, so the app gives the gesture itself: a pull down from the top of a list calls `refresh`.

/** How far a finger has to pull down, in CSS px, before the release refreshes. */
const PULL_PX = 80;

/** Inside one of these a pull belongs to the element (text, a sheet), never to the page. */
const OWN_PULL = "input, textarea, [contenteditable=true], dialog, [role=dialog]";

/** atTop says the list under `target` (its nearest scrolling box, else the page) shows its top. */
function atTop(target: EventTarget | null): boolean {
  for (let el = target instanceof Element ? target : null; el; el = el.parentElement) {
    if (el.scrollHeight > el.clientHeight && /auto|scroll/.test(getComputedStyle(el).overflowY)) return el.scrollTop <= 0;
  }
  return scrollY <= 0;
}

/**
 * pullToRefresh calls `refresh` when one finger starts at the top of a list, pulls mostly straight down by PULL_PX or more, and lets go
 * with the list still at its top. Screens without a coarse pointer get nothing.
 */
export function pullToRefresh(refresh: () => void): void {
  if (!matchMedia("(pointer: coarse)").matches) return;
  let start: { x: number; y: number; target: EventTarget | null } | null = null;
  addEventListener(
    "touchstart",
    (e) => {
      const t = e.touches[0];
      const own = e.target instanceof Element && e.target.closest(OWN_PULL);
      start = e.touches.length === 1 && t && !own && atTop(e.target) ? { x: t.clientX, y: t.clientY, target: e.target } : null;
    },
    { passive: true },
  );
  addEventListener(
    "touchend",
    (e) => {
      const t = e.changedTouches[0];
      const from = start;
      start = null;
      if (!from || !t) return;
      const down = t.clientY - from.y;
      if (down >= PULL_PX && down > 2 * Math.abs(t.clientX - from.x) && atTop(from.target)) refresh();
    },
    { passive: true },
  );
}
