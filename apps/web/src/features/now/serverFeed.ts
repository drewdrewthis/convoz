import type { FeedItem } from "@convoz/api-client";
import { useCallback, useEffect, useState } from "react";
import { ApiError, call, client, humanError } from "../../shared/api.ts";
import { useLive } from "../../shared/data.ts";
import { useNotice } from "../../shared/notice.tsx";
import { itemsOrEmpty } from "./entries.ts";
export { nextOf, shown } from "./entries.ts";

/** The server's own word for a refused move on a changed item (409): the owner reads the item again, then decides. */
export const CHANGED = "This changed, look again.";

/** useServerFeed reads GET /api/feed (the owner's feed items) and again on every live frame. A failed read, such as a member who is not the owner, leaves the list empty. */
export function useServerFeed() {
  const { fail } = useNotice();
  const [items, setItems] = useState<readonly FeedItem[]>([]);
  const [busy, setBusy] = useState(0);
  const load = useCallback(() => itemsOrEmpty(call(client.GET("/api/feed"))).then(setItems), []);
  useEffect(() => void load(), [load]);
  useLive(() => void load());
  /** act runs one move on an item, then reads the feed again. A 409 reads again too and says the item changed. */
  const act = async (id: number, run: () => Promise<unknown>) => {
    setBusy(id);
    try {
      await run();
      await load();
    } catch (err) {
      await load();
      fail(err instanceof ApiError && err.status === 409 ? CHANGED : humanError(err));
    } finally {
      setBusy(0);
    }
  };
  const path = (id: number) => ({ params: { path: { id } } });
  return {
    items,
    busy,
    accept: (i: FeedItem) => act(i.id, () => call(client.POST("/api/feed/{id}/accept", { ...path(i.id), body: { if_version: i.version } }))),
    ack: (i: FeedItem) => act(i.id, () => call(client.POST("/api/feed/{id}/ack", path(i.id)))),
    answer: (i: FeedItem, text: string) => act(i.id, () => call(client.POST("/api/feed/{id}/answer", { ...path(i.id), body: { text } }))),
    snooze: (i: FeedItem, until: number) => act(i.id, () => call(client.PUT("/api/feed/{id}/snooze", { ...path(i.id), body: { until } }))),
  };
}
