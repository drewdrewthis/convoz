import { create } from "zustand";

// The keys of the urgent things the popup already showed and the owner put off (Later, Escape, Reply), kept on the device so a
// reload or another page does not pop them again. They stay in Now; only the popup leaves them alone.

const KEY = "convoz.urgentSeen";
const KEPT = 200;

function read(): string[] {
  try {
    const list: unknown = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(list) ? list.filter((k): k is string => typeof k === "string") : [];
  } catch {
    return [];
  }
}

interface PopSeenState {
  seen: ReadonlySet<string>;
  /** see marks a popped key seen, newest 200 kept. */
  see: (key: string) => void;
}

/** usePopSeen holds the popped keys the owner put off and keeps them on the device. */
export const usePopSeen = create<PopSeenState>((set, get) => ({
  seen: new Set(read()),
  see: (key) => {
    const list = [...get().seen].filter((k) => k !== key).concat(key).slice(-KEPT);
    try {
      localStorage.setItem(KEY, JSON.stringify(list));
    } catch {
      /* a full disk keeps the marks for this visit only */
    }
    set({ seen: new Set(list) });
  },
}));
