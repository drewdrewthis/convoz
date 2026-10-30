import type { FeedItem } from "@convoz/api-client";
import { useCallback, useEffect, useState } from "react";
import { ApiError, call, client } from "../../shared/api.ts";
import { useLive } from "../../shared/data.ts";
import { toast, toastFailure } from "../pins-stars/index.ts";
import { itemsOrEmpty } from "./entries.ts";
export { nextOf, shown } from "./entries.ts";

/** The server's own word for a refused move on a changed item (409): the owner reads the item again, then decides. */
export const CHANGED = "This changed, look again.";

/** useServerFeed reads GET /api/feed (the owner's feed items) and again on every live frame. A failed read, such as a member who is not the owner, leaves the list empty. */
export function useServerFeed() {
  const [items, setItems] = useState<readonly FeedItem[]>([]);
  const [busy, setBusy] = useState(0);
  const load = useCallback(() => itemsOrEmpty(call(client.GET("/api/feed"))).then(setItems), []);
  useEffect(() => void load(), [load]);
  useLive(() => void load());
  /**
   * act runs one move on an item, then reads the feed again. A 409 says the item changed; any other failure toasts, with Retry when
   * sending it again could help (the server restarting). `done` runs once the move went through, on the first try or on a Retry.
   */
  const act = async (id: number, run: () => Promise<unknown>, done?: () => void): Promise<boolean> => {
    setBusy(id);
    try {
      await run();
      done?.();
      return true;
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) toast(CHANGED);
      else toastFailure(err, () => void act(id, run, done));
      return false;
    } finally {
      await load();
      setBusy(0);
    }
  };
  const path = (id: number) => ({ params: { path: { id } } });
  return {
    items,
    busy,
    accept: (i: FeedItem) => act(i.id, () => call(client.POST("/api/feed/{id}/accept", { ...path(i.id), body: { if_version: i.version } }))),
    ack: (i: FeedItem) => act(i.id, () => call(client.POST("/api/feed/{id}/ack", path(i.id)))),
    /** reply sends `text`; `sent` runs once the server took it (the box empties then, not before). */
    reply: (i: FeedItem, text: string, sent?: () => void) => act(i.id, () => call(client.POST("/api/feed/{id}/reply", { ...path(i.id), body: { text } })), sent),
    snooze: (i: FeedItem, until: number) => act(i.id, () => call(client.PUT("/api/feed/{id}/snooze", { ...path(i.id), body: { until } }))),
  };
}
