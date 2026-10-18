// The offline cache: what the shared data cache holds is written through to IndexedDB (db/schema.ts), and read back at the
// next start, so the rail and the last messages show before the network answers (design §9). The sync cursor and the outbox
// live there too. IndexedDB can be missing or refuse (a private window, a full disk): every function here then does nothing,
// and the app runs on the network alone.
import type { IDBPDatabase } from "idb";
import type { DataCache, DataState } from "../cache.ts";
import { clearCache, openCache, type ConvozDB } from "../db/schema.ts";
import { memoryOutbox, type Outbox } from "../outbox.ts";
import type { CursorStore } from "../sync.ts";
import type { Conversation, Message } from "../types.ts";
import { formatCursor, parseCursor } from "./cursor.ts";

export type CacheDb = IDBPDatabase<ConvozDB>;

/** What the offline shell shows: the newest messages of the most recent conversations (design §9). */
const KEEP_CONVERSATIONS = 20;
const KEEP_MESSAGES = 200;
/**
 * A change is written this long after it, with every change made meanwhile, so a burst of frames is one transaction. The wait counts
 * from the first unwritten change, not the last: a sync whose reads land closer together than this (the 20 conversations of
 * keepForOffline on a fast link) is still written as it goes, and a page closed or cut off midway keeps what it had read.
 */
const WRITE_DELAY_MS = 150;

/** openOfflineCache opens the cache database; null when the browser has none or refuses it. */
export async function openOfflineCache(): Promise<CacheDb | null> {
  try {
    return await openCache();
  } catch {
    return null;
  }
}

const newestFirst = (a: Conversation, b: Conversation) => b.last_activity_at - a.last_activity_at || b.id - a.id;

/** What hydrate found in the store: the person it belongs to, and the messages already written (by conversation, then id). */
export interface Stored {
  owner: number | null;
  messages: Map<number, Map<number, Message>>;
}

const NOTHING: Stored = { owner: null, messages: new Map() };

/**
 * hydrate reads the stored cache into the shared cache, for what the network has not filled yet, and drops what the offline
 * shell does not keep (messages of old conversations, and all but the newest 200 of a conversation). Who is signed in, the crew
 * and the conversation list come first; the messages (up to 20 x 200, the largest read) wait for `messagesAfter`, so a first
 * screen that does not show them (Now, the list) is not held up by reading them.
 */
export async function hydrate(cache: DataCache, dbp: Promise<CacheDb | null>, messagesAfter: Promise<unknown> = Promise.resolve()): Promise<Stored> {
  const db = await dbp;
  if (!db) return NOTHING;
  try {
    const [me, identities, conversations] = await Promise.all([db.get("me", "me"), db.getAll("identities"), db.getAll("conversations")]);
    conversations.sort(newestFirst);
    cache.store.setState((s) => ({
      me: s.me ?? me ?? null,
      identities: s.identities ?? (identities.length ? identities : null),
      conversations: s.conversations ?? (conversations.length ? conversations : null),
      rows: { ...Object.fromEntries(conversations.map((c) => [c.id, c])), ...s.rows },
    }));
    await messagesAfter;
    const stored = await db.getAllFromIndex("messages", "conversation");
    const kept = new Set(conversations.slice(0, KEEP_CONVERSATIONS).map((c) => c.id));
    const byConversation = new Map<number, (Message & { conversation_id: number })[]>();
    const drop: number[] = [];
    for (const m of stored) {
      if (!kept.has(m.conversation_id)) drop.push(m.id);
      else byConversation.set(m.conversation_id, [...(byConversation.get(m.conversation_id) ?? []), m]);
    }
    for (const [id, list] of byConversation) {
      drop.push(...list.slice(0, -KEEP_MESSAGES).map((m) => m.id));
      byConversation.set(id, list.slice(-KEEP_MESSAGES));
    }
    if (drop.length) {
      const tx = db.transaction("messages", "readwrite");
      await Promise.all([...drop.map((id) => tx.store.delete(id)), tx.done]);
    }
    for (const [id, list] of byConversation) cache.putMessages(id, list);
    return { owner: me?.identity.id ?? null, messages: new Map([...byConversation].map(([id, list]) => [id, new Map(list.map((m) => [m.id, m]))])) };
  } catch {
    return NOTHING;
  }
}

/** The running write-through of the shared cache to IndexedDB. */
export interface OfflineCopy {
  /** Write what the cache holds now; resolves once it is on disk (or the disk refused it). */
  saved(): Promise<void>;
  /** Stop writing. */
  stop(): void;
}

/**
 * persist writes the shared cache through to IndexedDB as it changes. When the cache learns that the signed-in person is not
 * the one the stored data belongs to, it drops what it held and the stored copy first.
 */
export function persist(cache: DataCache, dbp: Promise<CacheDb | null>, stored: Stored = NOTHING): OfflineCopy {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let owner = stored.owner;
  const wrote: { me: unknown; identities: unknown; conversations: unknown; rows: unknown; lists: Map<number, unknown>; messages: Map<number, Map<number, Message>> } = {
    me: null, identities: null, conversations: null, rows: null, lists: new Map(), messages: new Map(stored.messages),
  };
  let queue: Promise<void> = Promise.resolve();

  async function write(db: CacheDb, s: DataState) {
    if (s.me && owner !== null && owner !== s.me.identity.id) {
      cache.store.setState({ identities: null, conversations: null, rows: {}, messages: {} });
      await clearCache(db);
      wrote.identities = wrote.conversations = wrote.rows = null;
      wrote.lists.clear();
      wrote.messages.clear();
      owner = null;
      return;
    }
    const tx = db.transaction(["me", "identities", "conversations", "messages"], "readwrite");
    if (s.me && s.me !== wrote.me) {
      void tx.objectStore("me").put(s.me, "me");
      owner = s.me.identity.id;
      wrote.me = s.me;
    }
    if (s.identities && s.identities !== wrote.identities) {
      void tx.objectStore("identities").clear();
      for (const p of s.identities) void tx.objectStore("identities").put(p);
      wrote.identities = s.identities;
    }
    if (s.conversations !== wrote.conversations || s.rows !== wrote.rows) {
      if (s.conversations && s.conversations !== wrote.conversations) void tx.objectStore("conversations").clear();
      // The list goes last: it is the server's newest word on every conversation it holds, and a row read back from the store at
      // start (hydrate) must not overwrite it, or a conversation that has since moved up looks old and its messages are dropped.
      for (const c of [...Object.values(s.rows), ...(s.conversations ?? [])]) void tx.objectStore("conversations").put(c);
      wrote.conversations = s.conversations;
      wrote.rows = s.rows;
    }
    for (const [id, held] of Object.entries(s.messages)) {
      const conv = Number(id);
      if (wrote.lists.get(conv) === held.list) continue;
      // A message is written again when the cache replaced it (an ask answered or closed, an edit): the cache keeps the object of a
      // message that did not change, so a different object is a newer row.
      const have = wrote.messages.get(conv) ?? new Map<number, Message>();
      for (const m of held.list) {
        if (have.get(m.id) !== m) void tx.objectStore("messages").put({ ...m, conversation_id: conv });
        have.set(m.id, m);
      }
      wrote.messages.set(conv, have);
      wrote.lists.set(conv, held.list);
    }
    await tx.done;
  }

  const flush = () => {
    clearTimeout(timer);
    timer = undefined;
    queue = queue.then(async () => {
      const db = await dbp;
      if (db) await write(db, cache.store.getState()).catch(() => {}); // a full disk loses the offline copy, not the app
    });
    return queue;
  };
  const soon = () => {
    timer ??= setTimeout(flush, WRITE_DELAY_MS);
  };
  const leaving = () => {
    if (document.visibilityState === "hidden") flush();
  };

  const unsubscribe = cache.store.subscribe(soon);
  addEventListener("pagehide", flush);
  document.addEventListener("visibilitychange", leaving);
  soon();
  return {
    saved: flush,
    stop: () => {
      unsubscribe();
      removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", leaving);
      clearTimeout(timer);
    },
  };
}

/**
 * startOfflineCache fills the shared cache from the store, then keeps the store in step with it.
 * `messagesAfter`: when the stored messages may be read (see hydrate); at once by default.
 */
export async function startOfflineCache(cache: DataCache, dbp: Promise<CacheDb | null>, o: { messagesAfter?: Promise<unknown> } = {}): Promise<OfflineCopy> {
  return persist(cache, dbp, await hydrate(cache, dbp, o.messagesAfter));
}

/** cursorStore keeps the sync cursor in the `meta` store. */
export function cursorStore(dbp: Promise<CacheDb | null>): CursorStore {
  return {
    load: async () => {
      const db = await dbp;
      return db ? parseCursor((await db.get("meta", "cursor").catch(() => null)) as string | null) : null;
    },
    save: (cursor) => {
      void dbp.then((db) => db?.put("meta", formatCursor(cursor), "cursor")).catch(() => {});
    },
  };
}

/** forgetOfflineData empties every store: the person signed out, or the device was revoked. */
export async function forgetOfflineData(dbp: Promise<CacheDb | null>): Promise<void> {
  const db = await dbp;
  if (db) await clearCache(db).catch(() => {});
}

/**
 * idbOutbox keeps the sends the server has not confirmed in the `outbox` store, one operation at a time in the order they
 * were asked. With no IndexedDB the sends live in memory for the life of the page.
 */
export function idbOutbox(dbp: Promise<CacheDb | null>): Outbox {
  const fallback = memoryOutbox();
  let chain: Promise<unknown> = Promise.resolve();
  const run = <T>(onDb: (db: CacheDb) => Promise<T>, onMemory: () => Promise<T>): Promise<T> => {
    const next = chain.then(async () => {
      const db = await dbp;
      if (!db) return onMemory();
      try {
        return await onDb(db);
      } catch {
        return onMemory();
      }
    });
    chain = next.catch(() => {});
    return next;
  };
  return {
    put: (item) => run(async (db) => void (await db.put("outbox", item)), () => fallback.put(item)),
    remove: (cid) => run(async (db) => db.delete("outbox", cid), () => fallback.remove(cid)),
    list: () => run((db) => db.getAllFromIndex("outbox", "created"), () => fallback.list()),
  };
}
