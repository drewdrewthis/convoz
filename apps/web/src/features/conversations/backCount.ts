import { data, useData } from "../../shared/data.ts";
import { openCount, useNow } from "../now/index.ts";
import { useEffect } from "react";

/**
 * useBackCount is what waits outside the open conversation: the other conversations with unread messages (the list's own
 * rule, `unread > 0`) plus what the Now tab counts. The list and Now follow the live stream, so it moves without a reload.
 */
export function useBackCount(current: number): number {
  const others = useData((s) => s.conversations?.filter((c) => c.id !== current && c.unread > 0).length ?? 0);
  const waiting = openCount(useNow((s) => s.now)) ?? 0;
  useEffect(() => {
    void data.loadConversations().catch(() => {});
    useNow.getState().load().catch(() => {});
  }, []);
  return others + waiting;
}

/** backLabel is the Back button's name; the count joins it only when something waits. */
export const backLabel = (count: number): string => (count > 0 ? `Back, ${count > 99 ? "99+" : count} new` : "Back");
