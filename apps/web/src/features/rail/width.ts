import { create } from "zustand";
import { RAIL_DEFAULT, clampWidth, parseWidth } from "./widthRange.ts";

// The owner can drag the desktop sidebar to a width they like; it stays across loads on this browser.
const KEY = "convoz.rail.width";
const read = (): number => {
  try {
    return parseWidth(localStorage.getItem(KEY));
  } catch {
    return RAIL_DEFAULT;
  }
};

// The stylesheet reads --rail-w. This module loads with the main bundle, so the saved width is set before the first screen paints.
const apply = (w: number) => document.documentElement.style.setProperty("--rail-w", `${w}px`);

/** useRailWidth holds the sidebar's width in px and keeps it in the stylesheet and in this browser. */
export const useRailWidth = create<{ width: number; set(w: number): void; reset(): void }>()((set) => ({
  width: read(),
  set: (w) => {
    const width = clampWidth(w);
    try {
      localStorage.setItem(KEY, String(width));
    } catch {
      // private mode: the width holds for this page only
    }
    apply(width);
    set({ width });
  },
  reset: () => {
    try {
      localStorage.removeItem(KEY);
    } catch {
      // private mode
    }
    apply(RAIL_DEFAULT);
    set({ width: RAIL_DEFAULT });
  },
}));

apply(useRailWidth.getState().width);
