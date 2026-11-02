// What an agent's card in the details panel says: its state and its open items here. Items (`convoz item`) and the older plan
// (`convoz plan`) both count, so started, blocking and queued work shows whatever plan it is in. Pure: the time is the caller's.
import type { FeedItem, Plan, PlanAgent } from "@convoz/api-client";
import type { Tone } from "../plan/index.ts";

/** The line under the agent's name: when it was last seen (0: never), when its work last changed, or a fixed text. */
export type CardSub = { seen: number } | { updated: number } | { text: string };

export interface CardState {
  word: string;
  tone: Tone;
  sub: CardSub;
}

export interface AgentWork {
  /** null: no plan and no open item, so the card asks for a plan. */
  state: CardState | null;
  /** The agent's open items in this conversation: the now ones (started, blocking) first, then the queued ones, each in plan order. */
  items: FeedItem[];
}

const OPEN = ["started", "blocking", "pending"];

/** agentWork reads one agent's card: liveness first, then what blocks or is late, then what it works on, then what waits. */
export function agentWork({ plan, agent, items, id, conv, now }: { plan: Plan | undefined; agent: PlanAgent | undefined; items: readonly FeedItem[]; id: number | undefined; conv: number; now: number }): AgentWork {
  const mine = items
    .filter((i) => i.agent_id === id && i.conversation_id === conv && OPEN.includes(i.state))
    .sort((a, b) => Number(a.state === "pending") - Number(b.state === "pending") || a.seq - b.seq);
  return { state: stateOf(plan, agent, mine, now), items: mine };
}

function stateOf(plan: Plan | undefined, agent: PlanAgent | undefined, items: FeedItem[], now: number): CardState | null {
  const seen = { seen: agent?.last_seen_at ?? 0 };
  if (agent?.liveness === "logged_out") return { word: "Logged out", tone: "amber", sub: seen };
  if (agent?.liveness === "not_responding") return { word: "Not responding", tone: "amber", sub: seen };
  if (!plan && !items.length) return null;
  const sub = { updated: Math.max(plan?.updated_at ?? 0, ...items.map((i) => i.updated_at)) };
  const has = (state: string) => items.some((i) => i.state === state);
  if (plan?.blocked) return { word: "Blocked", tone: "red", sub };
  if (has("blocking")) return { word: "Waiting on you", tone: "amber", sub };
  if (plan?.doing && plan.eta && now >= plan.eta) return { word: "Behind", tone: "amber", sub };
  if (plan?.doing && !plan.eta && plan.due_at && now >= plan.due_at) return { word: "No update", tone: "amber", sub: { text: "no update for 2 h" } };
  if (plan?.doing || has("started")) return { word: "Working", tone: "green", sub };
  if (plan?.waiting.length) return { word: "Waiting on you", tone: "amber", sub };
  if (items.length) return { word: "Queued", tone: "grey", sub };
  return { word: "Done", tone: "grey", sub };
}
