// How a deliverable reads: its group on the page, its state word and glyph, its due text and the daily line. The server decides each
// state; this file only words it. Times are the owner's, in this browser's zone; every "now" is the server's (useDeliveries().skew).
import type { Deliveries, Delivery } from "@convoz/api-client";
import { span, when, type Tone } from "../plan/index.ts";

const DAY = 86_400_000;
const dayStart = (ms: number) => new Date(ms).setHours(0, 0, 0, 0);
/** How many calendar days after today's the instant falls (0 today, 1 tomorrow). */
const daysFrom = (ms: number, now: number) => Math.round((dayStart(ms) - dayStart(now)) / DAY);

export type GroupKey = "late" | "waiting" | "today" | "tomorrow" | "week" | "later";

/** The groups of the page in order: the two the owner must act on, then by day (ux spec, conv 179). */
export const GROUPS: { key: GroupKey; label: string }[] = [
  { key: "late", label: "Late" },
  { key: "waiting", label: "Waiting on you" },
  { key: "today", label: "Today" },
  { key: "tomorrow", label: "Tomorrow" },
  { key: "week", label: "This week" },
  { key: "later", label: "Later" },
];

/** groupOf is the group of one row. At risk keeps its date group, so the date stays true; its glyph and word say the risk. */
export function groupOf(d: Delivery, now: number): GroupKey {
  if (d.state === "late") return "late";
  if (d.state === "waiting") return "waiting";
  const days = daysFrom(d.due, now);
  return days <= 0 ? "today" : days === 1 ? "tomorrow" : days < 7 ? "week" : "later";
}

/** grouped is the rows in their groups, each by due time (the most overdue first in Late); empty groups are left out. */
export function grouped(rows: readonly Delivery[], now: number): { key: GroupKey; label: string; rows: Delivery[] }[] {
  return GROUPS.map((g) => ({ ...g, rows: rows.filter((d) => groupOf(d, now) === g.key).sort((a, b) => a.due - b.due) })).filter((g) => g.rows.length);
}

export interface StateLook {
  word: string;
  tone: Tone;
  glyph: "clock" | "alert" | "hand" | null;
}

/** The word, colour and glyph of a state; the colour never stands alone. */
export const STATE: Record<Delivery["state"], StateLook> = {
  late: { word: "Late", tone: "red", glyph: "clock" },
  at_risk: { word: "At risk", tone: "amber", glyph: "alert" },
  waiting: { word: "Waiting on you", tone: "amber", glyph: "hand" },
  on_track: { word: "On track", tone: "grey", glyph: null },
};

/** dueText is the short due text at the end of a row: "Late · 2 h", "18:00", "Tue 18:00" or "12 Nov". */
export function dueText(d: Delivery, now: number): string {
  if (d.state === "late") return `Late · ${span(now - d.due)}`;
  if (daysFrom(d.due, now) < 7) return when(d.due, now);
  return new Date(d.due).toLocaleDateString([], { day: "numeric", month: "short" });
}

/** subText is "@agent · state word · detail": when it was due, what blocks it, since when the plan is quiet, or the conversation. */
export function subText(d: Delivery, now: number): string {
  const detail =
    d.state === "late"
      ? `was due ${when(d.due, now)}`
      : d.state === "at_risk" && d.blocked
        ? `Blocked: ${d.blocked}`
        : d.state === "at_risk" && d.stale
          ? `no plan update since ${when(d.plan_updated_at, now)}`
          : d.title;
  return [`@${d.handle}`, STATE[d.state].word, detail].filter(Boolean).join(" · ");
}

export interface Daily {
  shipped: number;
  dueToday: number;
  late: number;
}

/** daily counts each item once: shipped today, still open and due before midnight, and late. */
export function daily(data: Deliveries, now: number): Daily {
  return {
    shipped: data.shipped.filter((s) => daysFrom(s.at, now) === 0).length,
    dueToday: data.deliveries.filter((d) => d.state !== "late" && daysFrom(d.due, now) <= 0).length,
    late: data.deliveries.filter((d) => d.state === "late").length,
  };
}

/** dailyLine is "Shipped today 3 · Due today 5 · Late 2" (a part at 0 is left out); with nothing late it starts "Nothing late". */
export function dailyLine({ shipped, dueToday, late }: Daily): string {
  const parts = late
    ? [shipped && `Shipped today ${shipped}`, dueToday && `Due today ${dueToday}`, `Late ${late}`]
    : ["Nothing late", dueToday && `Due today ${dueToday}`, shipped && `Shipped today ${shipped}`];
  return parts.filter(Boolean).join(" · ");
}
