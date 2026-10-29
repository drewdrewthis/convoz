import { create } from "zustand";
import type { Fyi } from "./feed.ts";

// Seen marks of the fyi cards the browser builds (the owner's questions, plan lines). They have no server row, so Okay and Snooze cannot go to /api/feed.
// This holds only marks (a key, a time), no feed data. The server should keep these as real feed items (follow-up).

/** What the owner did with one card: okayed it when it last changed at okAt, or snoozed it until `until` when it last changed at `at`. */
export interface Mark {
  okAt?: number;
  snooze?: { until: number; at: number };
}
export type Marks = Record<string, Mark>;

export const okayMark = (m: Marks, key: string, at: number): Marks => ({ ...m, [key]: { ...m[key], okAt: at } });
export const snoozeMark = (m: Marks, key: string, until: number, at: number): Marks => ({ ...m, [key]: { ...m[key], snooze: { until, at } } });

/** unseen drops a card okayed or snoozed that has not moved since; a card that moves (newer `at`) comes back, like the server's ack rule. */
export function unseen(list: readonly Fyi[], marks: Marks, now: number): Fyi[] {
  return list.filter((f) => {
    const m = marks[f.key];
    if (!m) return true;
    if (m.okAt !== undefined && f.at <= m.okAt) return false;
    if (m.snooze && f.at <= m.snooze.at && now < m.snooze.until) return false;
    return true;
  });
}

const KEY = "convoz.dev.fyiSeen";
const KEPT = 200;
function read(): Marks {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "{}") as Marks;
  } catch {
    return {};
  }
}

interface SeenState {
  marks: Marks;
  okay: (f: Fyi) => void;
  snooze: (f: Fyi, until: number) => void;
}

/** useSeen holds the marks and keeps them on the device, newest 200 only. */
export const useSeen = create<SeenState>((set, get) => {
  const keep = (marks: Marks) => {
    const trimmed = Object.fromEntries(Object.entries(marks).slice(-KEPT));
    try {
      localStorage.setItem(KEY, JSON.stringify(trimmed));
    } catch {
      /* a full disk keeps the marks for this visit only */
    }
    set({ marks: trimmed });
  };
  return { marks: read(), okay: (f) => keep(okayMark(get().marks, f.key, f.at)), snooze: (f, until) => keep(snoozeMark(get().marks, f.key, until, f.at)) };
});
