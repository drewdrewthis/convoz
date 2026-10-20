import { create } from "zustand";

// The owner folds the threads of one conversation away (msg 1855: a starred conversation listed 25 threads and flooded the rail); each
// choice stays across loads on this browser, like the sidebar fold.
const KEY = "convoz.threads.folded";

const read = (): number[] => {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((n): n is number => typeof n === "number") : [];
  } catch {
    return [];
  }
};

/** useThreadFold holds the conversations whose thread rows are folded away in the lists. */
export const useThreadFold = create<{ folded: number[]; toggle(id: number): void }>()((set, get) => ({
  folded: read(),
  toggle: (id) => {
    const now = get().folded;
    const folded = now.includes(id) ? now.filter((n) => n !== id) : [...now, id];
    try {
      localStorage.setItem(KEY, JSON.stringify(folded));
    } catch {
      // private mode: the fold holds for this page only
    }
    set({ folded });
  },
}));
