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
export const useThreadFold = create<{ folded: number[]; toggle(id: number): void; toggleAll(ids: number[]): void }>()((set, get) => {
  const keep = (folded: number[]) => {
    try {
      localStorage.setItem(KEY, JSON.stringify(folded));
    } catch {
      // private mode: the fold holds for this page only
    }
    set({ folded });
  };
  return {
    folded: read(),
    toggle: (id) => {
      const now = get().folded;
      keep(now.includes(id) ? now.filter((n) => n !== id) : [...now, id]);
    },
    /** Fold every conversation of `ids`, or show them all again when they are all folded already. */
    toggleAll: (ids) => keep(ids.every((id) => get().folded.includes(id)) ? [] : ids),
  };
});
