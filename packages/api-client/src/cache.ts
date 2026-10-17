// The shared data cache: the server data more than one feature reads (who is signed in, identities, the conversation
// list, conversation rows and their messages). Features keep only their own UI state in their own stores and read this
// one; it changes only through its actions and through frames the sync engine hands it. It persists to db/ later.
import { createStore, type StoreApi } from "zustand/vanilla";
import { coalesce } from "./coalesce.ts";
import type { DataSource } from "./source.ts";
import type { Conversation, Frame, Identity, Me, Message, PrefsResponse } from "./types.ts";

/** Messages per page, as the server pages them. */
export const LIMIT = 100;
/** A burst of frames reloads the list once. */
const LIST_DEBOUNCE_MS = 80;

/** The messages of one conversation the client holds, ascending by id. */
export interface MessageList {
  list: Message[];
  hasEarlier: boolean;
}

export interface DataState {
  me: Me | null;
  identities: Identity[] | null;
  /** The conversation list, in the server's order; null until first loaded. */
  conversations: Conversation[] | null;
  /** Conversation rows by id, for a conversation that is open. */
  rows: Record<number, Conversation>;
  /** Messages by conversation id, only for the conversations whose newest page was loaded. */
  messages: Record<number, MessageList>;
}

export interface DataCache {
  store: StoreApi<DataState>;
  loadMe(): Promise<Me>;
  loadIdentities(): Promise<Identity[]>;
  /** Reload the list (calls while one runs become one more run). */
  loadConversations(): Promise<void>;
  loadConversation(id: number): Promise<Conversation>;
  putConversation(c: Conversation): void;
  /** The newest page of a conversation. */
  loadNewest(id: number): Promise<void>;
  /** The page before the oldest message held. */
  loadEarlier(id: number): Promise<void>;
  /** Start holding the messages of a conversation the client just made (it has none yet), so its frames are kept. */
  track(id: number): void;
  /** Merge server messages by id, so nothing shows twice; returns the ones that were new. */
  putMessages(id: number, list: Message[]): Message[];
  /** Take in one live frame (the sync engine calls this before the features' handlers). False means it is not news: a
   *  message the cache already held, so no handler should see it again. */
  apply(frame: Frame): boolean;
  /** Take in the owner's own prefs after a star, mute or move (the answer of the PATCH, or a prefs.changed frame): the flags and every rank that moved. */
  applyPrefs(p: Pick<PrefsResponse, "conversation_id" | "starred" | "muted_until" | "ranks">): void;
  /** Change one conversation's row in the list and in the held rows at once, for an update the server has not answered yet. */
  patchConversation(id: number, change: Partial<Conversation>): void;
  /** After a gap: reload what the stream may have missed (the list; messages are caught up by the sync engine). */
  resync(): void;
}

/** maxId is the newest message id held for a conversation, 0 for none. */
export const maxId = (m: MessageList | undefined): number => (m?.list.length ? m.list[m.list.length - 1]!.id : 0);

/** changed says whether an incoming copy of a held message is newer: edited, deleted, purged, with more replies, or with files
 *  that changed (a transcript came; the local copy made at send time is replaced by the server's). */
const changed = (a: Message, b: Message) =>
  a.edited_at !== b.edited_at || !!a.deleted !== !!b.deleted || !!a.purged !== !!b.purged || a.reply_count !== b.reply_count || a.last_reply_at !== b.last_reply_at ||
  JSON.stringify(a.uploads) !== JSON.stringify(b.uploads);

function merge(have: Message[], more: Message[]): Message[] {
  const byId = new Map(have.map((m) => [m.id, m]));
  let touched = false;
  for (const m of more) {
    const held = byId.get(m.id);
    if (!held || changed(held, m)) {
      byId.set(m.id, m);
      touched = true;
    }
  }
  return touched ? [...byId.values()].sort((a, b) => a.id - b.id) : have;
}

/** createDataCache builds the cache over a data source. */
export function createDataCache(source: DataSource): DataCache {
  const store = createStore<DataState>()(() => ({ me: null, identities: null, conversations: null, rows: {}, messages: {} }));
  const { getState: get, setState: set } = store;
  let listTimer: ReturnType<typeof setTimeout> | undefined;
  const reloadList = coalesce(async () => set({ conversations: await source.conversations() }));
  const setList = (id: number, change: (m: MessageList) => MessageList) =>
    set((s) => ({ messages: { ...s.messages, [id]: change(s.messages[id] ?? { list: [], hasEarlier: false }) } }));

  const mapRows = (change: (c: Conversation) => Conversation) =>
    set((s) => ({
      conversations: s.conversations ? s.conversations.map(change) : s.conversations,
      rows: Object.fromEntries(Object.entries(s.rows).map(([k, c]) => [k, change(c)])),
    }));

  const cache: DataCache = {
    store,
    loadMe: async () => {
      const me = await source.me();
      set({ me });
      return me;
    },
    loadIdentities: async () => {
      const identities = await source.identities();
      set({ identities });
      return identities;
    },
    loadConversations: async () => {
      clearTimeout(listTimer);
      await reloadList();
    },
    loadConversation: async (id) => {
      const c = await source.conversation(id);
      cache.putConversation(c);
      return c;
    },
    putConversation: (c) => set((s) => ({ rows: { ...s.rows, [c.id]: c } })),
    loadNewest: async (id) => {
      const { messages } = await source.messages(id, { limit: LIMIT });
      setList(id, (m) => ({ list: merge(m.list, messages), hasEarlier: messages.length >= LIMIT }));
    },
    loadEarlier: async (id) => {
      const held = get().messages[id];
      if (!held?.list.length) return;
      const { messages } = await source.messages(id, { before: held.list[0]!.id, limit: LIMIT });
      setList(id, (m) => ({ list: merge(m.list, messages), hasEarlier: messages.length >= LIMIT }));
    },
    track: (id) => {
      if (!get().messages[id]) setList(id, (m) => m);
    },
    putMessages: (id, list) => {
      const held = get().messages[id]?.list ?? [];
      const added = list.filter((m) => !held.some((h) => h.id === m.id));
      if (added.length) setList(id, (m) => ({ ...m, list: merge(m.list, added) }));
      return added;
    },
    apply: (frame) => {
      switch (frame.name) {
        case "message.created": {
          // A reply stays in its thread (features/threads); only the list row follows it, since the unread count changed.
          if (frame.data.thread_root_id && !frame.data.broadcast) break;
          const held = get().messages[frame.data.conversation_id];
          if (held?.list.some((m) => m.id === frame.data.id)) return false;
          if (held) cache.putMessages(frame.data.conversation_id, [frame.data]);
          break;
        }
        case "message.edited":
        case "upload.transcribed":
        case "message.deleted":
        case "message.purged": {
          const held = get().messages[frame.data.conversation_id];
          if (!held || (frame.data.thread_root_id && !frame.data.broadcast)) return true; // a reply is changed in its thread
          const mine = held.list.find((m) => m.id === frame.data.id);
          if (mine && !changed(mine, frame.data)) return false;
          setList(frame.data.conversation_id, (m) => ({ ...m, list: merge(m.list, [frame.data]) }));
          break;
        }
        case "thread.updated": {
          const { conversation_id: conv, root_id, reply_count, last_reply_at } = frame.data;
          setList(conv, (m) => ({ ...m, list: m.list.map((x) => (x.id === root_id ? { ...x, reply_count, last_reply_at: last_reply_at ?? x.last_reply_at } : x)) }));
          return true;
        }
        case "agent.working":
          return true; // presence only: nothing cached
        case "ask.changed": {
          // The ask lives in its message: a held copy shows the new state at once. Not a new message, so the list stays.
          const ask = frame.data;
          if (!get().messages[ask.conversation_id]) return true;
          setList(ask.conversation_id, (m) => ({ ...m, list: m.list.map((x) => (x.id === ask.id ? { ...x, ask: { ...ask, snoozed_until: undefined } } : x)) }));
          return true;
        }
        case "pin.changed":
        case "agent.status_changed":
          return true; // presence, pins and status: the features that show them read the server themselves
        case "prefs.changed":
          cache.applyPrefs(frame.data);
          return true;
      }
      // the list follows message.created, read.moved and conversation.created, a burst at a time
      if (get().conversations) {
        clearTimeout(listTimer);
        listTimer = setTimeout(() => void reloadList(), LIST_DEBOUNCE_MS);
      }
      return true;
    },
    applyPrefs: (p) => {
      const ranks = new Map(p.ranks.map((r) => [r.id, r.rank]));
      mapRows((c) => {
        const rank = ranks.get(c.id);
        if (c.id !== p.conversation_id && rank === undefined) return c;
        const next: Conversation = { ...c, rank: rank ?? c.rank };
        if (c.id === p.conversation_id) {
          next.starred = p.starred;
          next.older = p.starred ? false : c.older; // a starred conversation never folds into Older
          if (p.muted_until === null) delete next.muted_until;
          else next.muted_until = p.muted_until;
        }
        return next;
      });
    },
    patchConversation: (id, change) => mapRows((c) => (c.id === id ? { ...c, ...change } : c)),
    resync: () => {
      if (get().conversations) void reloadList();
    },
  };
  return cache;
}
