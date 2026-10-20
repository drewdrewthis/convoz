import { create } from "zustand";

// The owner can fold the desktop sidebar to a thin strip (msg 1791); the choice stays across loads on this browser.
const KEY = "convoz.rail.folded";

const read = (): boolean => {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
};

const mark = (folded: boolean) => document.body.toggleAttribute("data-rail-folded", folded);

/** useFold holds whether the sidebar is folded, and marks the body so the stylesheet gives the page the room. */
export const useFold = create<{ folded: boolean; toggle(): void }>()((set, get) => ({
  folded: read(),
  toggle: () => {
    const folded = !get().folded;
    try {
      localStorage.setItem(KEY, folded ? "1" : "0");
    } catch {
      // private mode: the fold holds for this page only
    }
    mark(folded);
    set({ folded });
  },
}));

mark(useFold.getState().folded);
