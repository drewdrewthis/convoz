// What the owner sees of an agent's attention, kept per conversation: who is replying (live only) and who has seen the owner's
// newest message (stored on the server, so a page also reads it on load). The conversation page, its thread pane and the Now cards
// all read from here, so they agree.
import { registerHandler, type Seen } from "@convoz/api-client";
import { useEffect, useState } from "react";
import { create } from "zustand";

/** How long a replying note stays when the frame has no `until`. */
const WORKING_DEFAULT_MS = 300_000;

/** An agent at work in one place of a conversation: the thread of `root`, or the main list for 0. */
export interface Working {
  handle: string;
  until: number;
  root: number;
}

/** An agent that saw message `messageId` (the newest the owner wrote in a place). */
export interface SeenEntry {
  handle: string;
  messageId: number;
  at: number;
}

interface PresenceState {
  working: Record<number, Working[]>;
  /** By "<conversation>:<root>". */
  seen: Record<string, SeenEntry[]>;
  /** By the same key: the newest id the owner wrote there, so a "seen" of an older message stops showing. */
  floor: Record<string, number>;
  setWorking(conv: number, handle: string, on: boolean, until?: number, root?: number): void;
  hydrate(conv: number, root: number, seen: readonly Seen[] | undefined): void;
  markSeen(conv: number, root: number, entry: SeenEntry): void;
  owned(conv: number, root: number, id: number): void;
}

const keyOf = (conv: number, root: number) => `${conv}:${root}`;

function withEntry(list: SeenEntry[] | undefined, e: SeenEntry): SeenEntry[] {
  const held = (list ?? []).find((x) => x.handle === e.handle);
  if (held && held.messageId >= e.messageId) return list!;
  return [...(list ?? []).filter((x) => x.handle !== e.handle), e];
}

export const usePresence = create<PresenceState>()((set) => ({
  working: {},
  seen: {},
  floor: {},
  setWorking: (conv, handle, on, until, root = 0) =>
    set((s) => {
      const others = (s.working[conv] ?? []).filter((w) => w.handle !== handle);
      if (!on && others.length === (s.working[conv] ?? []).length) return s;
      return { working: { ...s.working, [conv]: on ? [...others, { handle, until: until || Date.now() + WORKING_DEFAULT_MS, root }] : others } };
    }),
  hydrate: (conv, root, seen) =>
    set((s) => {
      if (!seen?.length) return s;
      const k = keyOf(conv, root);
      return { seen: { ...s.seen, [k]: seen.reduce((list, e) => withEntry(list, { handle: e.handle, messageId: e.message_id, at: e.at }), s.seen[k] ?? []) } };
    }),
  markSeen: (conv, root, entry) => set((s) => ({ seen: { ...s.seen, [keyOf(conv, root)]: withEntry(s.seen[keyOf(conv, root)], entry) } })),
  owned: (conv, root, id) => set((s) => (id > (s.floor[keyOf(conv, root)] ?? 0) ? { floor: { ...s.floor, [keyOf(conv, root)]: id } } : s)),
}));

registerHandler("agent.", (frame) => {
  if (frame.name !== "agent.working") return;
  const d = frame.data;
  usePresence.getState().setWorking(d.conversation_id, d.handle, Boolean(d.working), d.until, d.thread_root_id);
});
registerHandler("message.", (frame) => {
  const state = usePresence.getState();
  if (frame.name === "message.seen") {
    const d = frame.data;
    state.markSeen(d.conversation_id, d.thread_root_id ?? 0, { handle: d.handle, messageId: d.message_id, at: d.at });
    return;
  }
  if (frame.name !== "message.created") return;
  const m = frame.data;
  const conv = m.conversation_id;
  if (m.author.kind === "agent") {
    state.setWorking(conv, m.author.handle, false); // the agent answered
  } else if (m.author.kind === "human") {
    // a newer message of the owner: nobody has seen it yet
    state.owned(conv, m.thread_root_id ?? 0, m.id);
    if (m.broadcast) state.owned(conv, 0, m.id);
  }
});

/** The handles that have seen message `messageId` in a place (the thread of `root`, or the main list for 0), first seen first. */
export function useSeenBy(conv: number, root: number, messageId?: number): string[] {
  const list = usePresence((s) => s.seen[keyOf(conv, root)]);
  const floor = usePresence((s) => s.floor[keyOf(conv, root)] ?? 0);
  return (list ?? []).filter((e) => e.messageId >= floor && (messageId === undefined || e.messageId === messageId)).sort((a, b) => a.at - b.at).map((e) => e.handle);
}

/** The handles that are replying now: in one place, or anywhere in the conversation when `root` is left out. */
export function useReplying(conv: number, root?: number): string[] {
  const list = usePresence((s) => s.working[conv]);
  const [, tick] = useState(0);
  const now = Date.now();
  const live = (list ?? []).filter((w) => w.until > now);
  const next = live.reduce((soonest, w) => Math.min(soonest, w.until), Infinity);
  // a claim that ends without a post or an ack clears itself at `until`
  useEffect(() => {
    if (!Number.isFinite(next)) return;
    const timer = setTimeout(() => tick((n) => n + 1), Math.max(0, next - Date.now()) + 1);
    return () => clearTimeout(timer);
  }, [next]);
  return live.filter((w) => root === undefined || w.root === root).map((w) => w.handle);
}

/** "@a", "@a and @b", "@a, @b and @c". */
export function handles(list: readonly string[]): string {
  const named = list.map((h) => `@${h}`);
  return named.length < 2 ? named.join("") : `${named.slice(0, -1).join(", ")} and ${named.at(-1)}`;
}

/** "@a is replying…" or "@a and @b are replying…"; null for nobody. */
export function replyingNote(list: readonly string[]): string | null {
  return list.length ? `${handles(list)} ${list.length === 1 ? "is" : "are"} replying…` : null;
}

/** "Seen by @a", "Seen by @a and @b", and "Seen by 3" from three agents on; null for nobody. */
export function seenNote(list: readonly string[]): string | null {
  if (!list.length) return null;
  return list.length > 2 ? `Seen by ${list.length}` : `Seen by ${handles(list)}`;
}
