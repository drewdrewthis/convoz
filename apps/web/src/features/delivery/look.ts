// How the Deliveries page reads: one row per plan (an agent in a conversation), its state, its group and its texts, and the daily line.
// Owner (Drew, conv 179, msg 9982): "The deliveries should show all the plans with the ability to request the updates right there."
// Times are the owner's, in this browser's zone; every "now" is the server's (the skew of usePlans or useDeliveries).
import type { Conversation, Deliveries, Plan, PlanAgent, PlanBoard } from "@convoz/api-client";
import { ago, span, when, type Tone } from "../plan/index.ts";

const DAY = 86_400_000;
const dayStart = (ms: number) => new Date(ms).setHours(0, 0, 0, 0);
/** How many calendar days after today's the instant falls (0 today, 1 tomorrow). */
const daysFrom = (ms: number, now: number) => Math.round((dayStart(ms) - dayStart(now)) / DAY);

export type RowState = "late" | "waiting" | "blocked" | "at_risk" | "on_track";
export type GroupKey = RowState | "today" | "tomorrow" | "week" | "later" | "none";

/** The groups of the page in order: what needs the owner first, then by the earliest delivery date, then the plans with none (ux spec, conv 179). */
export const GROUPS: { key: GroupKey; label: string }[] = [
  { key: "late", label: "Late" },
  { key: "waiting", label: "Waiting on you" },
  { key: "blocked", label: "Blocked" },
  { key: "at_risk", label: "At risk" },
  { key: "today", label: "Today" },
  { key: "tomorrow", label: "Tomorrow" },
  { key: "week", label: "This week" },
  { key: "later", label: "Later" },
  { key: "none", label: "No date" },
];

export interface StateLook {
  word: string;
  tone: Tone;
  glyph: "clock" | "alert" | "hand" | null;
}

/** The word, colour and glyph of a state; the colour never stands alone. */
export const STATE: Record<RowState, StateLook> = {
  late: { word: "Late", tone: "red", glyph: "clock" },
  waiting: { word: "Waiting on you", tone: "amber", glyph: "hand" },
  blocked: { word: "Blocked", tone: "red", glyph: "alert" },
  at_risk: { word: "At risk", tone: "amber", glyph: "alert" },
  on_track: { word: "On track", tone: "grey", glyph: null },
};

/** One plan of the page, with what its row needs. */
export interface PlanRow {
  key: string;
  plan: Plan;
  /** The title of the plan's conversation. */
  title: string;
  agent: PlanAgent | undefined;
  state: RowState;
  group: GroupKey;
  /** How long the most overdue date (a delivery or a Now estimate) has passed; 0 when none has. */
  overdue: number;
  /** The earliest delivery date; 0 for none. */
  due: number;
}

/** A plan counts while it holds something to do: one with only finished items is over. */
const current = (p: Plan) => p.now.length > 0 || (p.deliver?.length ?? 0) > 0 || Boolean(p.blocked) || p.waiting.length > 0 || p.next.length > 0;

/**
 * rowsOf is the plans of the page: every current plan whose conversation is in the owner's list (not in the trash), not closed, and that
 * still has its agent. A plan of an agent that left, or in a closed conversation, has ended.
 */
export function rowsOf(board: PlanBoard, convs: readonly Conversation[], now: number): PlanRow[] {
  const byId = new Map(convs.map((c) => [c.id, c]));
  const out: PlanRow[] = [];
  for (const plan of board.plans) {
    const c = byId.get(plan.conversation_id);
    if (!c || c.stale || !current(plan) || !c.participants.some((p) => p.kind === "agent" && p.handle === plan.handle)) continue;
    const passed = [...(plan.deliver ?? []).map((d) => d.due), ...plan.now.map((n) => n.eta ?? 0)].filter((t) => t && t <= now);
    const overdue = passed.length ? now - Math.min(...passed) : 0;
    const due = Math.min(Infinity, ...(plan.deliver ?? []).map((d) => d.due));
    const state: RowState = overdue ? "late" : plan.waiting.length ? "waiting" : plan.blocked ? "blocked" : now - plan.updated_at >= DAY ? "at_risk" : "on_track";
    out.push({
      key: `${plan.conversation_id}-${plan.identity_id}`,
      plan,
      title: c.title || `Conversation ${c.id}`,
      agent: board.agents.find((a) => a.identity_id === plan.identity_id),
      state,
      group: state !== "on_track" ? state : due === Infinity ? "none" : dayGroup(due, now),
      overdue,
      due: due === Infinity ? 0 : due,
    });
  }
  return out;
}

function dayGroup(due: number, now: number): GroupKey {
  const days = daysFrom(due, now);
  return days <= 0 ? "today" : days === 1 ? "tomorrow" : days < 7 ? "week" : "later";
}

/** The order inside a group: the most overdue first in Late, the latest update first in No date, else the earliest date first. */
function order(key: GroupKey): (a: PlanRow, b: PlanRow) => number {
  if (key === "late") return (a, b) => b.overdue - a.overdue;
  if (key === "none") return (a, b) => b.plan.updated_at - a.plan.updated_at;
  return (a, b) => (a.due || Infinity) - (b.due || Infinity) || b.plan.updated_at - a.plan.updated_at;
}

/** grouped is the rows in their groups, in order; empty groups are left out. */
export function grouped(rows: readonly PlanRow[]): { key: GroupKey; label: string; rows: PlanRow[] }[] {
  return GROUPS.map((g) => ({ ...g, rows: rows.filter((r) => r.group === g.key).sort(order(g.key)) })).filter((g) => g.rows.length);
}

/** titleOf is the first line of a row: the first Now item, else the first deliverable. */
export const titleOf = (p: Plan): string => p.now[0]?.text ?? p.deliver?.[0]?.text ?? "Nothing planned";

/** subText is "@agent · state word · conversation title", or "@agent · Blocked: reason" for a blocked plan. */
export function subText(r: PlanRow): string {
  if (r.state === "blocked") return `@${r.plan.handle} · Blocked: ${r.plan.blocked}`;
  return `@${r.plan.handle} · ${STATE[r.state].word} · ${r.title}`;
}

/** dueText is the short text at the end of a row: "Late · 2 h", "18:00", "Tue 18:00", "12 Nov", or "updated 3 h ago" with no date. */
export function dueText(r: PlanRow, now: number): string {
  if (r.state === "late") return `Late · ${span(r.overdue)}`;
  if (!r.due) return `updated ${ago(r.plan.updated_at, now)}`;
  if (daysFrom(r.due, now) < 7) return when(r.due, now);
  return new Date(r.due).toLocaleDateString([], { day: "numeric", month: "short" });
}

export interface Daily {
  shipped: number;
  dueToday: number;
  late: number;
}

/** daily counts each deliverable once: shipped today, still open and due before midnight, and late. */
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
