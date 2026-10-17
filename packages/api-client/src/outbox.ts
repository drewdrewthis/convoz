// The outbox: sends the server has not confirmed. A send is put here before it is tried and removed when the server confirms
// it; one that was cut off (offline, the page closed) is sent again with the same client id, so a retry never makes a second
// message (I-24). `idbOutbox` (sync/persist.ts) keeps the items in the "outbox" store (db/schema.ts); `memoryOutbox` is the
// fallback where IndexedDB is not there.
export interface OutboxItem {
  /** The client id, made once per message. */
  cid: string;
  conversationId: number;
  body: string;
  createdAt: number;
}

export interface Outbox {
  put(item: OutboxItem): Promise<void>;
  remove(cid: string): Promise<void>;
  list(): Promise<OutboxItem[]>;
}

/** memoryOutbox keeps the items for the life of the page. */
export function memoryOutbox(): Outbox {
  const items = new Map<string, OutboxItem>();
  return {
    put: async (item) => void items.set(item.cid, item),
    remove: async (cid) => void items.delete(cid),
    list: async () => [...items.values()].sort((a, b) => a.createdAt - b.createdAt),
  };
}
