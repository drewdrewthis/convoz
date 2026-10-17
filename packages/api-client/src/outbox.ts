// The outbox: sends the server has not confirmed. Today the conversations feature keeps its pending sends in memory and
// retries them by hand; the sync engine work package persists this interface in the "outbox" store (db/schema.ts) and
// drains it on reconnect, with the same client id, so a retry never makes a second message (I-24).
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
