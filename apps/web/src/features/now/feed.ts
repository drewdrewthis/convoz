// The fyi items of the Now feed, from data the server already sends: the plans (PlanBoard) and the messages of the conversations.
// Pure functions, so they are tested without a screen. Nothing here is stored on the device (owner, conv 179 msg 11785: no fake data).
import type { Message, PlanBoard } from "@convoz/api-client";

/** One fyi item: it follows one piece of work. started: an agent works on it. done: it is finished or answered. */
export interface Fyi {
  /** The same piece of work is the same row as it moves from started to done. */
  key: string;
  state: "started" | "done";
  conversation_id: number;
  /** The agent of a plan step; a question has none. */
  handle?: string;
  /** The conversation's name, for the From link. */
  from: string;
  title: string;
  context?: string;
  /** The message the thread hangs on: only the owner's question has one (a plan step is no message). */
  root?: number;
  /** The later Now lines and the Next lines of the same plan, shown quietly under the item. */
  next?: string[];
  at: number;
}

/** startOfDay is local midnight of a moment, as epoch ms. */
export const startOfDay = (at: number): number => new Date(at).setHours(0, 0, 0, 0);

/**
 * planItems are the plan steps worked on or finished today, one row per step. For each plan the first Now line is the item; its later Now
 * lines and its Next lines show under it. A step that is both in Now and in Done shows its latest state.
 */
export function planItems(board: PlanBoard | undefined, fromOf: (conversation: number) => string): Fyi[] {
  if (!board) return [];
  const cut = startOfDay(board.now);
  const rows = new Map<string, Fyi>();
  for (const p of board.plans) {
    const key = (text: string) => `${p.conversation_id}:${p.handle}:${text}`;
    const base = { conversation_id: p.conversation_id, handle: p.handle, from: fromOf(p.conversation_id) };
    const [first, ...later] = p.now;
    if (first) {
      const at = first.since ?? p.doing_since ?? board.now;
      if (at >= cut) rows.set(key(first.text), { ...base, key: key(first.text), state: "started", title: first.text, context: `@${p.handle} started this`, next: [...later.map((l) => l.text), ...p.next], at });
    }
    for (const d of p.done) {
      if (d.at < cut) continue;
      const held = rows.get(key(d.text));
      if (held && held.at > d.at) continue;
      rows.set(key(d.text), { ...base, key: key(d.text), state: "done", title: `${d.text} — done`, context: `@${p.handle} finished this`, at: d.at });
    }
  }
  return [...rows.values()];
}

const lines = (body: string): string[] => body.replace(/\p{Cf}/gu, "").split("\n").map((l) => l.trim()).filter(Boolean);

/**
 * questionsOf is the owner's latest question of one conversation (a message the owner wrote in the main chat in the last 24 hours) as an item,
 * when an agent has answered it (in the chat after it, or in its thread). Done ("Answered") when the last word is an agent's; started
 * when the owner wrote again in the question's thread after the agent's reply. No agent reply: no item.
 */
export function questionsOf(conversation: number, from: string, list: readonly Message[], me: string, now: number): Fyi | null {
  const mine = (m: Message) => m.author.handle === me && m.kind !== "system" && m.kind !== "ask";
  const q = [...list].reverse().find((m) => mine(m) && !m.thread_root_id && m.created_at >= now - 86_400_000 && lines(m.body).length);
  if (!q) return null;
  const after = list.filter((m) => m.id > q.id && (!m.thread_root_id || m.thread_root_id === q.id));
  const agent = after.filter((m) => m.author.kind === "agent" && m.kind !== "ask" && lines(m.body).length);
  const last = agent[agent.length - 1];
  if (!last) return null;
  const spoke = after.some((m) => mine(m) && m.id > last.id);
  return {
    key: `q:${conversation}:${q.id}`,
    root: q.id,
    state: spoke ? "started" : "done",
    conversation_id: conversation,
    from,
    title: `Your question: ${lines(q.body)[0]}`,
    context: lines(last.body).slice(0, 2).join(" "),
    at: last.created_at,
  };
}
