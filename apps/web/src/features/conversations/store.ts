// The conversations feature's UI state: for each open conversation page, the sends not yet confirmed
// and the read cursor the server took (who is replying and who has seen is in shared/presence.ts). Server data (rows, messages, identities) is in the shared cache (shared/data.ts).
import type { Message, Upload } from "@convoz/api-client";
import { coalesce, maxId } from "@convoz/api-client";
import { create } from "zustand";
import { ApiError } from "../../shared/api.ts";
import { newId } from "../../shared/chat.ts";
import { data, outbox, source, sync } from "../../shared/data.ts";

/** A send waiting for the link looks again this often even if no `online` event comes. */
const OFFLINE_RECHECK_MS = 10_000;

/** An owner message not yet confirmed by the server. `base` is the newest id held when it was written. */
export interface PendingSend {
  cid: string;
  body: string;
  state: "sending" | "failed";
  base: number;
  /** The finished uploads the message carries. */
  uploadIds?: string[];
  /** Those uploads as the message shows them; absent for a send restored from the outbox (only the ids are kept there). */
  files?: Upload[];
}

/** One conversation page. A new conversation has convId 0 until its first send makes it. */
export interface Thread {
  convId: number;
  pending: PendingSend[];
  /** The newest id the server confirmed as read. */
  readOk: number;
  /** For a new conversation: the agents picked so far, and the client id that makes it (a retry reuses it). */
  start?: { handles: string[]; clientId: string };
}

export interface ConversationsState {
  threads: Record<string, Thread>;
  /** Open an existing conversation under `key`: its row and newest page. Throws ApiError 404 when it is not the owner's. */
  openThread(key: string, convId: number): Promise<void>;
  /** Start a new conversation with these agents (maybe none) under `key`; nothing is made on the server until the first send. */
  startThread(key: string, handles: string[]): void;
  loadEarlier(key: string): Promise<void>;
  catchUp(key: string): Promise<void>;
  /** A new server message: the owner's own copy replaces its pending send; */
  received(convId: number, m: Message): void;
  /** Send a message; `files` are finished uploads (the body may then be empty). */
  send(key: string, body: string, files?: Upload[]): void;
  retry(key: string, cid: string): void;
  markRead(key: string): Promise<void>;
  /** Send the unconfirmed sends of conversations no page has open (the outbox), after the link came back. */
  drainOutbox(): Promise<void>;
  /** Send the read cursor with keepalive, for a page that is going away. */
  flushRead(key: string): void;
}

const emptyThread = (convId: number): Thread => ({ convId, pending: [], readOk: 0 });
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

  /** The browser says it has no link: a send then waits in the outbox (design §9) instead of failing. */
  const linkDown = (err: unknown) => err instanceof TypeError && navigator.onLine === false;
  /** backOnline resolves when the link returns; the timer is a net for an `online` event the browser never sent. */
  const backOnline = () =>
    new Promise<void>((resolve) => {
      const done = () => {
        removeEventListener("online", done);
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(done, OFFLINE_RECHECK_MS);
      addEventListener("online", done);
    });

  async function deliver(key: string, cid: string) {
    const setState = (state: PendingSend["state"]) => patch(key, (t) => ({ pending: t.pending.map((p) => (p.cid === cid ? { ...p, state } : p)) }));
    setState("sending");
    let queued = false;
    for (;;) {
      try {
        let t = thread(key)!;
        if (!t.convId) {
          const made = await source.createConversation(t.start!.clientId, t.start!.handles);
          data.putConversation(made);
          data.track(made.id);
          patch(key, () => ({ convId: made.id }));
          t = thread(key)!;
        }
        const p = t.pending.find((x) => x.cid === cid)!;
        if (!queued) void outbox.put({ cid, conversationId: t.convId, body: p.body, uploadIds: p.uploadIds, createdAt: Date.now() }); // before the post: a cut-off send is found again
        queued = true;
        const sent = await source.post(t.convId, cid, p.body, p.uploadIds);
        void outbox.remove(cid);
        const me = data.store.getState().me!.identity;
        const files = p.files?.length ? { uploads: p.files } : {};
        data.putMessages(t.convId, [{ id: sent.id, author: { handle: me.handle, display_name: me.display_name, kind: "human" }, body: p.body, format: "plain", created_at: sent.created_at, ...files }]);
        patch(key, (now) => ({ pending: now.pending.filter((x) => x.cid !== cid) }));
        void get().markRead(key);
        if (untitled(t.convId)) data.loadConversation(t.convId).catch(() => {});
        return;
      } catch (err) {
        if (err instanceof ApiError && err.handled) return;
        if (!linkDown(err)) return setState("failed");
        await backOnline(); // the same client id goes out again, so a send that did arrive is not made twice (I-24)
      }
    }
  }

  /** deliver one at a time per page, in the order the owner sent: twenty sends over an unstable link arrive in order. */
  const queues = new Map<string, Promise<void>>();
  const enqueue = (key: string, cid: string) => {
    const run = (queues.get(key) ?? Promise.resolve()).then(() => deliver(key, cid));
    queues.set(key, run);
    return run;
  };

  /** Sends of this conversation that a closed page or a dead link left in the outbox go out again with their client ids. */
  async function restoreSends(key: string, convId: number) {
    for (const item of await outbox.list()) {
      if (item.conversationId !== convId || thread(key)?.pending.some((p) => p.cid === item.cid)) continue;
      patch(key, (t) => ({ pending: [...t.pending, { cid: item.cid, body: item.body, uploadIds: item.uploadIds, state: "sending", base: newest(convId) }] }));
      void enqueue(key, item.cid);
    }
  }

  return {
    threads: {},
    openThread: async (key, convId) => {
      set((s) => ({ threads: { ...s.threads, [key]: s.threads[key] ?? emptyThread(convId) } }));
      await data.loadConversation(convId);
      await data.loadNewest(convId);
      await restoreSends(key, convId);
    },
    startThread: (key, handles) => {
      set((s) => ({ threads: { ...s.threads, [key]: { ...emptyThread(0), start: { handles, clientId: newId() } } } }));
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
          return {};
        });
        void get().markRead(key);
      }
    },
    send: (key, body, files) => {
      const t = thread(key);
      if (!t) return;
      const cid = newId();
      const carried = files?.length ? { files, uploadIds: files.map((f) => f.id) } : {};
      patch(key, (now) => ({ pending: [...now.pending, { cid, body, state: "sending", base: newest(now.convId), ...carried }] }));
      void enqueue(key, cid);
    },
    retry: (key, cid) => void enqueue(key, cid),
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
    drainOutbox: async () => {
      for (const item of await outbox.list()) {
        if (Object.values(get().threads).some((t) => t.convId === item.conversationId)) continue; // its page sends it
        try {
          await source.post(item.conversationId, item.cid, item.body, item.uploadIds);
        } catch (err) {
          // a refusal that a retry cannot change is dropped; a dead link keeps the send for the next time
          if (!(err instanceof ApiError) || err.status === 401 || err.status === 408 || err.status === 429 || err.status >= 500) continue;
        }
        await outbox.remove(item.cid);
      }
    },
    flushRead: (key) => {
      const t = thread(key);
      if (!t?.convId) return;
      const top = newest(t.convId);
      if (top > t.readOk) void source.markRead(t.convId, top, true);
    },
  };
});
