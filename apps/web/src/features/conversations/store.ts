// The conversations feature's UI state: for each open conversation page, the sends not yet confirmed, the agent at work
// and the read cursor the server took. Server data (rows, messages, identities) is in the shared cache (shared/data.ts).
import type { Message } from "@convoz/api-client";
import { coalesce, maxId } from "@convoz/api-client";
import { create } from "zustand";
import { ApiError } from "../../shared/api.ts";
import { newId } from "../../shared/chat.ts";
import { data, source, sync } from "../../shared/data.ts";

/** How long a working note stays without an `until` from the server. */
const WORKING_DEFAULT_MS = 300_000;

/** An owner message not yet confirmed by the server. `base` is the newest id held when it was written. */
export interface PendingSend {
  cid: string;
  body: string;
  state: "sending" | "failed";
  base: number;
}

/** An agent at work in a conversation, until a message from it, a stop frame, or `until` (epoch ms). */
export interface Working {
  handle: string;
  until: number;
}

/** One conversation page. A new conversation has convId 0 until its first send makes it. */
export interface Thread {
  convId: number;
  pending: PendingSend[];
  working: Working | null;
  /** The newest id the server confirmed as read. */
  readOk: number;
  /** For a new conversation: the agent it is made with, and the client id that makes it (a retry reuses it). */
  start?: { handle: string; clientId: string };
}

export interface ConversationsState {
  threads: Record<string, Thread>;
  /** Open an existing conversation under `key`: its row and newest page. Throws ApiError 404 when it is not the owner's. */
  openThread(key: string, convId: number): Promise<void>;
  /** Start a new conversation with one agent under `key`; nothing is made on the server until the first send. */
  startThread(key: string, handle: string): void;
  loadEarlier(key: string): Promise<void>;
  catchUp(key: string): Promise<void>;
  /** A new server message: the owner's own copy replaces its pending send; one from the working agent ends the note. */
  received(convId: number, m: Message): void;
  send(key: string, body: string): void;
  retry(key: string, cid: string): void;
  markRead(key: string): Promise<void>;
  /** Send the read cursor with keepalive, for a page that is going away. */
  flushRead(key: string): void;
  setWorking(convId: number, handle: string, working: boolean, until?: number): void;
  clearWorking(key: string): void;
}

const emptyThread = (convId: number): Thread => ({ convId, pending: [], working: null, readOk: 0 });
const newest = (convId: number) => maxId(data.store.getState().messages[convId]);

export const useConversations = create<ConversationsState>()((set, get) => {
  const readJobs = new Map<string, () => Promise<void>>();
  const thread = (key: string): Thread | undefined => get().threads[key];
  const patch = (key: string, change: (t: Thread) => Partial<Thread>) =>
    set((s) => {
      const t = s.threads[key];
      if (!t) return s;
      const c = change(t);
      return Object.keys(c).length ? { threads: { ...s.threads, [key]: { ...t, ...c } } } : s;
    });
  const keysOf = (convId: number) => Object.keys(get().threads).filter((k) => convId !== 0 && get().threads[k]!.convId === convId);
  const untitled = (convId: number) => !data.store.getState().rows[convId]?.title;

  async function deliver(key: string, cid: string) {
    const setState = (state: PendingSend["state"]) => patch(key, (t) => ({ pending: t.pending.map((p) => (p.cid === cid ? { ...p, state } : p)) }));
    setState("sending");
    try {
      let t = thread(key)!;
      if (!t.convId) {
        const made = await source.createConversation(t.start!.clientId, [t.start!.handle]);
        data.putConversation(made);
        data.track(made.id);
        patch(key, () => ({ convId: made.id }));
        t = thread(key)!;
      }
      const p = t.pending.find((x) => x.cid === cid)!;
      const sent = await source.post(t.convId, cid, p.body);
      const me = data.store.getState().me!.identity;
      data.putMessages(t.convId, [{ id: sent.id, author: { handle: me.handle, display_name: me.display_name, kind: "human" }, body: p.body, format: "plain", created_at: sent.created_at }]);
      patch(key, (now) => ({ pending: now.pending.filter((x) => x.cid !== cid) }));
      void get().markRead(key);
      if (untitled(t.convId)) data.loadConversation(t.convId).catch(() => {});
    } catch (err) {
      if (err instanceof ApiError && err.handled) return;
      setState("failed");
    }
  }

  return {
    threads: {},
    openThread: async (key, convId) => {
      set((s) => ({ threads: { ...s.threads, [key]: s.threads[key] ?? emptyThread(convId) } }));
      await data.loadConversation(convId);
      await data.loadNewest(convId);
    },
    startThread: (key, handle) => {
      set((s) => ({ threads: { ...s.threads, [key]: { ...emptyThread(0), start: { handle, clientId: newId() } } } }));
    },
    loadEarlier: async (key) => {
      const t = thread(key);
      if (t?.convId) await data.loadEarlier(t.convId);
    },
    catchUp: async (key) => {
      const t = thread(key);
      if (t?.convId) await sync.catchUp(t.convId);
    },
    received: (convId, m) => {
      const mine = data.store.getState().me?.identity.handle;
      for (const key of keysOf(convId)) {
        patch(key, (t) => {
          if (m.author.handle === mine) {
            // the server's copy of a pending send (it came another way than the POST answer)
            const at = t.pending.findIndex((p) => p.body === m.body && m.id > p.base);
            return at >= 0 ? { pending: t.pending.filter((_, i) => i !== at) } : {};
          }
          return t.working && m.author.handle === t.working.handle ? { working: null } : {};
        });
        void get().markRead(key);
      }
    },
    send: (key, body) => {
      const t = thread(key);
      if (!t) return;
      const cid = newId();
      patch(key, (now) => ({ pending: [...now.pending, { cid, body, state: "sending", base: newest(now.convId) }] }));
      void deliver(key, cid);
    },
    retry: (key, cid) => void deliver(key, cid),
    markRead: (key) => {
      let job = readJobs.get(key);
      if (!job) {
        job = coalesce(async () => {
          const t = thread(key);
          if (!t || !t.convId || document.visibilityState !== "visible") return;
          const top = newest(t.convId);
          if (top <= t.readOk) return;
          if (await source.markRead(t.convId, top)) patch(key, (now) => ({ readOk: Math.max(now.readOk, top) }));
        });
        readJobs.set(key, job);
      }
      return job();
    },
    flushRead: (key) => {
      const t = thread(key);
      if (!t?.convId) return;
      const top = newest(t.convId);
      if (top > t.readOk) void source.markRead(t.convId, top, true);
    },
    setWorking: (convId, handle, on, until) => {
      for (const key of keysOf(convId)) {
        patch(key, (t) => {
          if (on) return { working: { handle, until: until || Date.now() + WORKING_DEFAULT_MS } };
          return t.working?.handle === handle ? { working: null } : {};
        });
      }
    },
    clearWorking: (key) => patch(key, () => ({ working: null })),
  };
});
