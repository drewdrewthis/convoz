// How the Work page reads (delivery.feature, Rule "Work shows every plan"). Owner (Drew, conv 179): one screen, in a hierarchy, of what
// needs him, what is blocked, what is in work and what is planned; "Deliverables are ALL plans, not a separate thing". One row per chat
// and agent, in the first section that applies. Pure: no store, no clock of its own (every "now" is the server's).
import type { Conversation, Deliveries, Plan, PlanAgent, PlanBoard } from "@convoz/api-client";

export type SectionKey = "needs" | "blocked" | "doing" | "planned";

/** The sections in order: the highest that applies to a plan holds its row. */
export const SECTIONS: { key: SectionKey; label: string }[] = [
  { key: "needs", label: "Needs you" },
  { key: "blocked", label: "Blocked or late" },
  { key: "doing", label: "In progress" },
  { key: "planned", label: "Planned" },
];

/** Why a row is where it is, when its section alone does not say. */
export type Why = "waiting" | "ask" | "blocked" | "late" | "logged_out" | "not_responding" | "doing" | "next" | "deliver";

export interface WorkRow {
  key: string;
  conv: number;
  /** The chat's title. */
  title: string;
  handle: string;
  /** The plan, if the agent has one here (an open ask alone has none). */
  plan: Plan | undefined;
  agent: PlanAgent | undefined;
  section: SectionKey;
  why: Why;
  /** The row's own words: the Waiting item, the reason, the late deliverable, the Now item or the first Next. */
  text: string;
  /** The earliest delivery date; 0 for none. */
  due: number;
  /** When the plan last changed; 0 for none. */
  updated: number;
  stale: boolean;
}

export interface DoneItem {
  key: string;
  text: string;
  handle: string;
  title: string;
  at: number;
}

export interface Section {
  key: SectionKey;
  label: string;
  rows: WorkRow[];
}

export interface Board {
  sections: Section[];
  /** How many stale chats have rows left out of In progress and Planned. */
  hidden: number;
  done: DoneItem[];
}

const sameDay = (a: number, b: number) => new Date(a).toDateString() === new Date(b).toDateString();

/** placeOf is the section and reason of a plan (or an open ask), the highest that applies; null when nothing is left to do. */
function placeOf(plan: Plan | undefined, ask: string | undefined, late: string | undefined, agent: PlanAgent | undefined): { section: SectionKey; why: Why; text: string } | null {
  if (plan?.waiting.length) return { section: "needs", why: "waiting", text: plan.waiting[0]!.text };
  if (ask !== undefined) return { section: "needs", why: "ask", text: ask };
  if (plan?.blocked) return { section: "blocked", why: "blocked", text: `Blocked: ${plan.blocked}` };
  if (late !== undefined) return { section: "blocked", why: "late", text: `Late: ${late}` };
  if (!plan) return null;
  const busy = plan.now.length > 0 || plan.next.length > 0 || (plan.deliver?.length ?? 0) > 0;
  if (busy && agent?.liveness === "logged_out") return { section: "blocked", why: "logged_out", text: "Logged out" };
  if (busy && agent?.liveness === "not_responding") return { section: "blocked", why: "not_responding", text: "Not responding" };
  if (plan.now.length) return { section: "doing", why: "doing", text: plan.now[0]!.text };
  if (plan.next.length) return { section: "planned", why: "next", text: plan.next[0]! };
  if (plan.deliver?.length) return { section: "planned", why: "deliver", text: `Deliver: ${plan.deliver[0]!.text}` };
  return null;
}

/** The order inside a section: Planned by the earliest date, the others by the latest change first. */
const order = (key: SectionKey) => (a: WorkRow, b: WorkRow) => (key === "planned" ? (a.due || Infinity) - (b.due || Infinity) : 0) || b.updated - a.updated;

/**
 * sections is the Work page: every plan (and every open ask of an agent) in a chat of the owner's list that still has that agent, in the
 * highest section that applies. A stale chat's rows are left out of In progress and Planned unless showStale; they still show when they
 * need the owner or are blocked or late. `done` is what the plans finished today, the newest first.
 */
export function sections(board: PlanBoard, deliveries: Deliveries | null, convs: readonly Conversation[], now: number, showStale = false): Board {
  const byId = new Map(convs.map((c) => [c.id, c]));
  const has = (c: Conversation, handle: string) => c.participants.some((p) => p.kind === "agent" && p.handle === handle);
  const late = new Map<string, string>();
  for (const d of deliveries?.deliveries ?? []) if (d.state === "late" && !late.has(`${d.conversation_id}-${d.handle}`)) late.set(`${d.conversation_id}-${d.handle}`, d.text);
  const asks = new Map(board.attention.filter((a) => a.state === "waiting").map((a) => [`${a.conversation_id}-${a.handle}`, a.text]));
  const rows: WorkRow[] = [];
  const hiddenChats = new Set<number>();
  const seen = new Set<string>();
  const add = (c: Conversation, handle: string, plan: Plan | undefined) => {
    const key = `${c.id}-${handle}`;
    if (seen.has(key) || !has(c, handle)) return;
    seen.add(key);
    const agent = board.agents.find((a) => a.handle === handle);
    const place = placeOf(plan, plan?.waiting.length ? undefined : asks.get(key), late.get(key), agent);
    if (!place) return;
    if (c.stale && !showStale && (place.section === "doing" || place.section === "planned")) {
      hiddenChats.add(c.id);
      return;
    }
    const due = Math.min(Infinity, ...(plan?.deliver ?? []).map((d) => d.due));
    rows.push({ key, conv: c.id, title: c.title || `Conversation ${c.id}`, handle, plan, agent, ...place, due: due === Infinity ? 0 : due, updated: plan?.updated_at ?? 0, stale: Boolean(c.stale) });
  };
  for (const plan of board.plans) {
    const c = byId.get(plan.conversation_id);
    if (c) add(c, plan.handle, plan);
  }
  for (const a of board.attention) {
    const c = byId.get(a.conversation_id);
    if (a.state === "waiting" && c) add(c, a.handle, undefined);
  }
  const done: DoneItem[] = [];
  for (const plan of board.plans) {
    const c = byId.get(plan.conversation_id);
    if (!c) continue;
    for (const d of plan.done) if (sameDay(d.at, now)) done.push({ key: `${c.id}-${plan.handle}-${d.at}-${d.text}`, text: d.text, handle: plan.handle, title: c.title || `Conversation ${c.id}`, at: d.at });
  }
  return {
    sections: SECTIONS.map((s) => ({ ...s, rows: rows.filter((r) => r.section === s.key).sort(order(s.key)) })).filter((s) => s.rows.length),
    hidden: hiddenChats.size,
    done: done.sort((a, b) => b.at - a.at),
  };
}
