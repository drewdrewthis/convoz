// The threads feature's state: the replies of every thread drawn inline in the open conversation, the replies not yet confirmed, which
// thread has its reply box open, and the read state. The root of a thread and the counts under it stay in the shared data cache
// (shared/data.ts), where the main list reads them.
import type { Message } from "@convoz/api-client";
import { create } from "zustand";
import { ApiError, call, client } from "../../shared/api.ts";
import { newId } from "../../shared/chat.ts";
import { data } from "../../shared/data.ts";
import { usePresence } from "../../shared/presence.ts";

/** A reply the server has not confirmed yet; the same shape as a pending send in the main list. */
export interface PendingReply {
  cid: string;
  body: string;
  state: "sending" | "failed";
  base: number;
  /** The finished uploads the reply carries. */
  uploadIds?: string[];
}

/** One thread as the conversation draws it under its root. */
export interface ThreadView {
  conversation: number;
  rootId: number;
  /** Server replies, ascending by id. */
  replies: Message[];
  pending: PendingReply[];
  loaded: boolean;
  /** The newest reply the server took as read. */
  readOk: number;
}

export interface ThreadsState {
  /** The threads of the open conversation, by root. */
  threads: Record<number, ThreadView>;
  /** Threads the owner unfolded (true) or folded (false) by hand; without a choice only the latest thread is unfolded. */
  unfolded: Record<number, boolean>;
  /** The root whose reply box is open: one at a time. */
  replying: number | null;
  /** The newest reply the viewer read here, by root: a thread shows its "new" count only for a reply past it. */
  readThrough: Record<number, number>;
  /** Load the replies of a thread (once; a live frame keeps them fresh). */
  load(conversation: number, rootId: number): Promise<void>;
  setUnfolded(rootId: number, on: boolean): void;
  /** Open the reply box under a root, unfolding its thread (Reply in thread, a #reply= link). */
  startReply(conversation: number, rootId: number): void;
  stopReply(): void;
  /** Send a reply (the body may be empty when it carries files); it shows at once as "sending". */
  reply(rootId: number, body: string, uploadIds?: string[]): void;
  retry(rootId: number, cid: string): void;
  /** Drop a failed reply the owner does not want to retry. */
  discard(rootId: number, cid: string): void;
  /** A live frame for a message: a reply of a thread on screen is taken in, edited or removed. */
  received(m: Message, conversation: number): void;
  /** Read every thread on screen again (after a gap in the stream). */
  refresh(): Promise<void>;
  /** Tell the server how far a thread was read. */
  markRead(rootId: number): Promise<void>;
  /** The conversation closed: its threads go. */
  reset(): void;
}

const byId = (a: Message, b: Message) => a.id - b.id;

function merge(have: Message[], more: Message[]): Message[] {
  const all = new Map(have.map((m) => [m.id, m]));
  for (const m of more) all.set(m.id, m);
  return [...all.values()].sort(byId);
}

const blank = (conversation: number, rootId: number): ThreadView => ({ conversation, rootId, replies: [], pending: [], loaded: false, readOk: 0 });

export const useThreads = create<ThreadsState>()((set, get) => {
  const loading = new Set<number>();
  const patch = (rootId: number, change: (t: ThreadView) => Partial<ThreadView>) =>
    set((s) => {
      const t = s.threads[rootId];
      return t ? { threads: { ...s.threads, [rootId]: { ...t, ...change(t) } } } : s;
    });
  const ensure = (conversation: number, rootId: number) => {
    if (!get().threads[rootId]) set((s) => ({ threads: { ...s.threads, [rootId]: blank(conversation, rootId) } }));
  };
  const newest = (t: ThreadView) => t.replies.at(-1)?.id ?? 0;

  async function fetchThread(rootId: number) {
    const t = get().threads[rootId];
    if (!t || loading.has(rootId)) return;
    loading.add(rootId);
    try {
      const { messages, seen } = await call(client.GET("/api/messages/{id}/replies", { params: { path: { id: rootId }, query: { limit: 100 } } }));
      if (!get().threads[rootId]) return;
      usePresence.getState().hydrate(t.conversation, rootId, seen);
      patch(rootId, (now) => ({ replies: merge(now.replies, messages), loaded: true }));
    } finally {
      loading.delete(rootId);
    }
  }

  async function deliver(rootId: number, cid: string) {
    const t = get().threads[rootId];
    const p = t?.pending.find((x) => x.cid === cid);
    if (!t || !p) return;
    const setState = (state: PendingReply["state"]) => patch(rootId, (now) => ({ pending: now.pending.map((x) => (x.cid === cid ? { ...x, state } : x)) }));
    setState("sending");
    try {
      const sent = await call(
        client.POST("/api/conversations/{id}/messages", {
          params: { path: { id: t.conversation } },
          body: { client_id: cid, body: p.body, thread_root_id: rootId, ...(p.uploadIds?.length ? { upload_ids: p.uploadIds } : {}) },
        }),
      );
      const me = data.store.getState().me!.identity;
      const made: Message = {
        id: sent.id,
        author: { handle: me.handle, display_name: me.display_name, kind: "human" },
        body: p.body,
        format: "plain",
        created_at: sent.created_at,
        thread_root_id: rootId,
      };
      // The stream may have brought the server's copy first, with its files: keep that one.
      patch(rootId, (now) => ({ replies: now.replies.some((r) => r.id === made.id) ? now.replies : merge(now.replies, [made]), pending: now.pending.filter((x) => x.cid !== cid) }));
    } catch (err) {
      if (err instanceof ApiError && err.handled) return;
      setState("failed");
    }
  }

  return {
    threads: {},
    unfolded: {},
    replying: null,
    readThrough: {},
    load: async (conversation, rootId) => {
      ensure(conversation, rootId);
      if (!get().threads[rootId]!.loaded) await fetchThread(rootId);
    },
    setUnfolded: (rootId, on) => set((s) => ({ unfolded: { ...s.unfolded, [rootId]: on } })),
    startReply: (conversation, rootId) => {
      ensure(conversation, rootId);
      set((s) => ({ replying: rootId, unfolded: { ...s.unfolded, [rootId]: true } }));
    },
    stopReply: () => set({ replying: null }),
    reply: (rootId, body, uploadIds) => {
      const t = get().threads[rootId];
      if (!t) return;
      const cid = newId();
      patch(rootId, (now) => ({ pending: [...now.pending, { cid, body, uploadIds, state: "sending", base: newest(now) }] }));
      void deliver(rootId, cid);
    },
    retry: (rootId, cid) => void deliver(rootId, cid),
    discard: (rootId, cid) => patch(rootId, (now) => ({ pending: now.pending.filter((x) => x.cid !== cid) })),
    received: (m, conversation) => {
      const root = m.thread_root_id;
      const t = root ? get().threads[root] : undefined;
      if (!root || !t || t.conversation !== conversation) return;
      const mine = data.store.getState().me?.identity.handle === m.author.handle;
      patch(root, (now) => {
        // the server's copy of a pending reply (it came by the stream before the answer to the POST)
        const at = mine && !now.replies.some((r) => r.id === m.id) ? now.pending.findIndex((p) => p.body === m.body && m.id > p.base) : -1;
        return { replies: merge(now.replies, [m]), pending: at >= 0 ? now.pending.filter((_, i) => i !== at) : now.pending };
      });
    },
    refresh: async () => {
      await Promise.all(Object.keys(get().threads).map((id) => fetchThread(Number(id)).catch(() => {})));
    },
    markRead: async (rootId) => {
      const t = get().threads[rootId];
      if (!t || document.visibilityState !== "visible") return;
      const top = newest(t);
      if (top <= t.readOk) return;
      try {
        const { response } = await client.POST("/api/conversations/{id}/read", { params: { path: { id: t.conversation } }, body: { root_id: rootId, reply_id: top } });
        if (!response.ok) return;
        patch(rootId, (now) => ({ readOk: Math.max(now.readOk, top) }));
        set((s) => ({ readThrough: { ...s.readThrough, [rootId]: Math.max(s.readThrough[rootId] ?? 0, top) } }));
        void data.loadConversations(); // the rail and the bold title follow
      } catch {
        // a lost position is sent again with the next reply
      }
    },
    reset: () => set({ threads: {}, unfolded: {}, replying: null }),
  };
});
