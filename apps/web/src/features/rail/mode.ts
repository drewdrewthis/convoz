import { create } from "zustand";

// On a desktop, Now is a view of the rail (proposal §1, owner conv 179): the rail lists what waits on the owner and the page keeps the
// open conversation. The choice stays across loads on this browser, as the fold does.
const KEY = "convoz.rail.mode";

const read = (): boolean => {
  try {
    return localStorage.getItem(KEY) === "now";
  } catch {
    return false;
  }
};

// The stylesheet widens the rail on this mark (only on a desktop, and never on the Now page, which is the Now list itself).
const mark = (now: boolean) => document.body.toggleAttribute("data-rail-now", now);

/** useRailMode holds whether the desktop rail shows Now instead of the conversations, and marks the body so the page gives it the room. */
export const useRailMode = create<{ now: boolean; set(now: boolean): void }>()((set) => ({
  now: read(),
  set: (now) => {
    try {
      localStorage.setItem(KEY, now ? "now" : "conversations");
    } catch {
      // private mode: the mode holds for this page only
    }
    mark(now);
    set({ now });
  },
}));

mark(useRailMode.getState().now);
