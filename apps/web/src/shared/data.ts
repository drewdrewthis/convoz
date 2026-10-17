// The app's one shared data cache and sync engine (packages/api-client), over the network and the offline cache. Features read server data
// with useData and keep their UI state in their own store (features/<f>/store.ts).
import { createDataCache, createSync, cursorStore, idbOutbox, startOfflineCache, type DataSource, type DataState } from "@convoz/api-client";
import { useEffect, useRef } from "react";
import { useStore } from "zustand";
import { call, client } from "./api.ts";
import { onResume } from "./chat.ts";
import { offline } from "./offline.ts";

/** source reads and writes through the generated API client. */
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

export const data = createDataCache(source);
// What the cache holds is kept in IndexedDB and read back at the next start, so the rail and the last messages show before the
// network answers; the sync cursor is kept with it, so a warm start reads only the delta (design §9).
void startOfflineCache(data, offline());
export const sync = createSync(data, source, { cursor: cursorStore(offline()) });
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
