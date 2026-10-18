// The threads feature's state: the one thread that is open, its replies and the replies not yet confirmed. The root of a thread
// and the counts under it stay in the shared data cache (shared/data.ts), where the main list reads them.
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

export interface OpenThread {
  conversation: number;
  /** The root; absent until it is loaded when the thread was opened from one of its replies. */
  root: Message | null;
  rootId: number;
  /** Server replies, ascending by id. */
  replies: Message[];
  pending: PendingReply[];
  loaded: boolean;
  /** The newest reply the server took as read. */
  readOk: number;
}

export interface ThreadsState {
  open: OpenThread | null;
  /** The newest reply the viewer read here, by root: a reply chip shows its unread dot only for a reply past it. */
  readThrough: Record<number, number>;
  /** Open the thread of a root and load its replies. `known` is the root as the page holds it, shown at once. */
  openThread(conversation: number, rootId: number, known?: Message): Promise<void>;
  close(): void;
  /** Send a reply (the body may be empty when it carries files); it shows at once as "sending". */
  reply(body: string, uploadIds?: string[]): void;
  retry(cid: string): void;
  /** A live frame for a message: a reply of the open thread is taken in, edited or removed. */
  received(m: Message, conversation: number): void;
  /** Read the thread again (after a gap in the stream). */
  refresh(): Promise<void>;
  /** Tell the server how far the open thread was read. */
  markRead(): Promise<void>;
}

const byId = (a: Message, b: Message) => a.id - b.id;

function merge(have: Message[], more: Message[]): Message[] {
  const all = new Map(have.map((m) => [m.id, m]));
  for (const m of more) all.set(m.id, m);
  return [...all.values()].sort(byId);
}

export const useThreads = create<ThreadsState>()((set, get) => {
  const patch = (change: (t: OpenThread) => Partial<OpenThread>) =>
    set((s) => (s.open ? { open: { ...s.open, ...change(s.open) } } : s));
  const isOpen = (root: number) => get().open?.rootId === root;
  const newest = (t: OpenThread) => t.replies.at(-1)?.id ?? 0;

  async function load(rootId: number) {
    const { root, messages, seen } = await call(client.GET("/api/messages/{id}/replies", { params: { path: { id: rootId }, query: { limit: 100 } } }));
    if (!isOpen(rootId)) return;
    usePresence.getState().hydrate(get().open!.conversation, rootId, seen);
    patch((t) => ({ root, replies: merge(t.replies, messages), loaded: true }));
    void get().markRead();
  }

  async function deliver(cid: string) {
    const t = get().open;
    const p = t?.pending.find((x) => x.cid === cid);
    if (!t || !p) return;
    const setState = (state: PendingReply["state"]) => patch((now) => ({ pending: now.pending.map((x) => (x.cid === cid ? { ...x, state } : x)) }));
    setState("sending");
    try {
      const sent = await call(
        client.POST("/api/conversations/{id}/messages", {
          params: { path: { id: t.conversation } },
          body: { client_id: cid, body: p.body, thread_root_id: t.rootId, ...(p.uploadIds?.length ? { upload_ids: p.uploadIds } : {}) },
        }),
      );
      const me = data.store.getState().me!.identity;
      const made: Message = {
        id: sent.id,
        author: { handle: me.handle, display_name: me.display_name, kind: "human" },
        body: p.body,
        format: "plain",
        created_at: sent.created_at,
        thread_root_id: t.rootId,
      };
      if (!isOpen(t.rootId)) return;
      // The stream may have brought the server's copy first, with its files: keep that one.
      patch((now) => ({ replies: now.replies.some((r) => r.id === made.id) ? now.replies : merge(now.replies, [made]), pending: now.pending.filter((x) => x.cid !== cid) }));
      void get().markRead();
    } catch (err) {
      if (err instanceof ApiError && err.handled) return;
      if (isOpen(t.rootId)) setState("failed");
    }
  }

  return {
    open: null,
    readThrough: {},
    openThread: async (conversation, rootId, known) => {
      if (get().open?.rootId !== rootId) set({ open: { conversation, root: known ?? null, rootId, replies: [], pending: [], loaded: false, readOk: 0 } });
      await load(rootId);
    },
    close: () => set({ open: null }),
    reply: (body, uploadIds) => {
      const t = get().open;
      if (!t) return;
      const cid = newId();
      patch((now) => ({ pending: [...now.pending, { cid, body, uploadIds, state: "sending", base: newest(now) }] }));
      void deliver(cid);
    },
    retry: (cid) => void deliver(cid),
    received: (m, conversation) => {
      const t = get().open;
      if (!t || t.conversation !== conversation || m.thread_root_id !== t.rootId) return;
      const mine = data.store.getState().me?.identity.handle === m.author.handle;
      patch((now) => {
        // the server's copy of a pending reply (it came by the stream before the answer to the POST)
        const at = mine ? now.pending.findIndex((p) => p.body === m.body && m.id > p.base) : -1;
        return { replies: merge(now.replies, [m]), pending: at >= 0 ? now.pending.filter((_, i) => i !== at) : now.pending };
      });
      void get().markRead();
    },
    refresh: async () => {
      const t = get().open;
      if (t) await load(t.rootId).catch(() => {});
    },
    markRead: async () => {
      const t = get().open;
      if (!t || document.visibilityState !== "visible") return;
      const top = newest(t);
      if (top <= t.readOk) return;
      try {
        const { response } = await client.POST("/api/conversations/{id}/read", { params: { path: { id: t.conversation } }, body: { root_id: t.rootId, reply_id: top } });
        if (!response.ok) return;
        patch((now) => ({ readOk: Math.max(now.readOk, top) }));
        set((s) => ({ readThrough: { ...s.readThrough, [t.rootId]: Math.max(s.readThrough[t.rootId] ?? 0, top) } }));
        void data.loadConversations(); // the rail and the bold title follow
      } catch {
        // a lost position is sent again with the next reply
      }
    },
  };
});
