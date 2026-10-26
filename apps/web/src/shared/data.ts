// The app's one shared data cache and sync engine (packages/api-client), over the network and the offline cache. Features read server data
// with useData and keep their UI state in their own store (features/<f>/store.ts).
import { createDataCache, createSync, cursorStore, idbOutbox, startOfflineCache, type DataCache, type DataSource, type DataState } from "@convoz/api-client";
import { useEffect, useRef } from "react";
import { useStore } from "zustand";
import { ApiError, call, client, isRevoking } from "./api.ts";
import { onResume } from "./chat.ts";
import { unreachable } from "./connection.ts";
import { offline } from "./offline.ts";
import { afterFirstScreen } from "./perf.ts";

/** network reads and writes through the generated API client. */
export const source: DataSource = {
  me: () => call(client.GET("/api/me")),
  identities: async () => (await call(client.GET("/api/identities"))).identities,
  conversations: async () => (await call(client.GET("/api/conversations"))).conversations,
  conversation: async (id) => (await call(client.GET("/api/conversations/{id}", { params: { path: { id } } }))).conversation,
  createConversation: async (clientId, participants) =>
    (await call(client.POST("/api/conversations", { body: { client_id: clientId, participants } }))).conversation,
  messages: (id, { before, after, limit }) =>
    call(client.GET("/api/conversations/{id}/messages", { params: { path: { id }, query: { before, after, limit } } })),
  post: (id, clientId, body, uploadIds) =>
    call(client.POST("/api/conversations/{id}/messages", { params: { path: { id } }, body: { client_id: clientId, body, upload_ids: uploadIds?.length ? uploadIds : undefined } })),
  markRead: async (id, mainId, keepalive = false) => {
    try {
      const { response } = await client.POST("/api/conversations/{id}/read", { params: { path: { id } }, body: { main_id: mainId }, keepalive });
      return response.ok;
    } catch {
      return false;
    }
  },
  snapshot: () => call(client.GET("/api/sync/snapshot")),
  delta: (cursor, wait, signal) => call(client.GET("/api/sync", { params: { query: { cursor, wait } }, signal })),
};

/** A refusal the cached copy must not cover: the person is gone (sign in), or the thing is (404), or it is not theirs (403). */
const final = (err: unknown): boolean =>
  err instanceof ApiError && (err.handled || err.status === 404 || err.status === 403 || (err.status === 401 && isRevoking(err.code)));

/**
 * fromCache is "network first, IndexedDB second" (design §9): when the server cannot be reached, or refuses for a reason that
 * leaves the device signed in (a 502, a bad token), the copy the cache holds stands in, and the offline banner says so.
 */
async function fromCache<T>(read: Promise<T>, held: () => T | null | undefined): Promise<T> {
  try {
    return await read;
  } catch (err) {
    if (final(err)) throw err;
    await ready;
    const have = held();
    if (have == null) throw err;
    unreachable();
    return have;
  }
}

const cached = () => data.store.getState();
const NO_MESSAGES = { messages: [] };
/** Set once this page load has the conversation list from the server (the early copy counts: the server made it for this page).
 *  The disk copy that fromCache falls back to never sets it. Page state only, never saved: a later page reads for itself. */
let listFromNetworkAt: number | null = null;
/** The list read in flight, if any: keepForOffline and the list's first reads wait for it rather than start one more behind it. */
let listReading: Promise<unknown> | null = null;
const listRead = () => {
  const read = source.conversations().then((list) => {
    listFromNetworkAt = performance.now();
    return list;
  });
  const settled: Promise<unknown> = read.catch(() => {}).then(() => {
    if (listReading === settled) listReading = null;
  });
  listReading = settled;
  return read;
};
/** How old the page's network list may be for a screen that mounts to take it rather than read again. */
const MOUNT_LIST_FRESH_MS = 2000;

/**
 * loadListOnMount is the list read of a screen that mounts (the rail, the list). It shares a list read already on its way, or a
 * list from the server under 2 s old, instead of queuing one more behind it; later, going back to the list reads again.
 */
export async function loadListOnMount(): Promise<void> {
  if (listReading) await listReading;
  if (listFromNetworkAt === null || performance.now() - listFromNetworkAt > MOUNT_LIST_FRESH_MS) await data.loadConversations();
}

/** readable is the network source with a cached answer behind every read the pages make. Sends and the sync engine's own reads still fail. */
const readable: DataSource = {
  ...source,
  me: () => fromCache(source.me(), () => cached().me),
  identities: () => fromCache(source.identities(), () => cached().identities),
  conversations: () => fromCache(listRead(), () => cached().conversations),
  conversation: (id) => fromCache(source.conversation(id), () => cached().rows[id]),
  messages: (id, page) =>
    fromCache(source.messages(id, page), () => {
      const held = cached().messages[id];
      if (!held) return null;
      return page.before || page.after ? NO_MESSAGES : { messages: held.list.slice(-page.limit) };
    }),
};

export const data: DataCache = createDataCache(readable);
// What the cache holds is kept in IndexedDB and read back at the next start, so the rail and the last messages show before the
// network answers; the sync cursor is kept with it, so a warm start reads only the delta (design §9). The stored messages, the
// largest read, wait until the first screen shows (Now and the list do not show them; a conversation page has no mark to wait for).
const ready = startOfflineCache(data, offline(), { messagesAfter: afterFirstScreen() });
/** offlineReady resolves once the IndexedDB copy is in the cache: a page draws from it at once and does not wait for the network. */
export const offlineReady = (): Promise<unknown> => ready;
export const sync = createSync(data, readable, { cursor: cursorStore(offline()) });
/** The sends the server has not confirmed; they survive a closed page and go out again with the same client id. */
export const outbox = idbOutbox(offline());

/** useData reads the shared cache; the component renders again when the selected part changes. */
export function useData<T>(select: (s: DataState) => T): T {
  return useStore(data.store, select);
}

/**
 * useLive holds the live stream open while the page shows. When the app comes back (bfcache, tab visible, network back)
 * the stream is reopened if the phone closed it, and `resume` runs so the page catches up.
 */
export function useLive(resume: () => void): void {
  const again = useRef(resume);
  again.current = resume;
  useEffect(() => {
    const release = sync.hold();
    const undo = onResume(() => {
      sync.ensure();
      again.current();
    });
    return () => {
      undo();
      release();
    };
  }, []);
}

/** What the offline shell keeps (design §9): the newest conversations, each with its last messages. */
const KEEP_CONVERSATIONS = 20;
const KEEP_MESSAGES = 200;
/** How many conversations the offline copy reads at once: a few cut the serial chain without crowding the network. */
const KEEP_AT_ONCE = 4;
let kept = false;
/** The open view's own reads; the offline copy waits for them so its ~40 requests never queue in front of them. */
let viewReads: Promise<unknown> = Promise.resolve();
/** The longest the offline copy waits for the open view's reads. */
const VIEW_WAIT_MS = 2000;

/** holdOfflineUntil makes keepForOffline start only after the open view's reads have settled (or 2 s have passed). */
export function holdOfflineUntil(reads: Promise<unknown>): void {
  viewReads = reads;
}

/**
 * keepForOffline reads who is signed in, the crew, and the 20 newest conversations with their last 200 messages (read 4 conversations at a time) into the cache (and so into IndexedDB), once per
 * page load and only where a service worker can open the app offline. It waits for the worker so it never competes with the first
 * screen, and skips a link that asked to save data. It sets the `kept-offline` mark when it is done, whatever the outcome, and only once
 * what it read is on disk: the offline copy an earlier page left can already hold as much, so only this mark says the copy is this page's.
 */
export async function keepForOffline(): Promise<void> {
  if (kept || !("serviceWorker" in navigator)) return;
  kept = true;
  try {
    await navigator.serviceWorker.ready;
    await afterFirstScreen();
    await Promise.race([viewReads.catch(() => {}), new Promise((r) => setTimeout(r, VIEW_WAIT_MS))]);
    if ((navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData) return;
    // the list this page already read from the server is fresh; one that came from the disk copy is read again
    if (listReading) await listReading;
    await Promise.all([data.loadMe(), data.loadIdentities(), listFromNetworkAt === null ? data.loadConversations() : undefined]);
    const list = (data.store.getState().conversations ?? []).slice(0, KEEP_CONVERSATIONS);
    let next = 0;
    const keep = async (c: (typeof list)[number]) => {
      await data.loadNewest(c.id);
      const held = data.store.getState().messages[c.id];
      if (held?.hasEarlier && held.list.length < KEEP_MESSAGES) await data.loadEarlier(c.id);
    };
    // a failed read stops new reads, but the error waits for the reads in flight: `kept-offline` must follow what was read
    const failed: unknown[] = [];
    await Promise.all(
      Array.from({ length: KEEP_AT_ONCE }, async () => {
        while (!failed.length && next < list.length) await keep(list[next++]!).catch((err: unknown) => void failed.push(err));
      }),
    );
    if (failed.length) throw failed[0];
  } catch {
    /* offline or refused: the next visit tries again */
  } finally {
    await (await ready).saved();
    performance.mark("kept-offline"); // like `tfus`: a trace or a test knows the page has gone quiet
  }
}
