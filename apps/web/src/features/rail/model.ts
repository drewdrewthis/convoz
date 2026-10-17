// What the rail shows, worked out from the conversation list: the three groups, their order and a row's words.
import type { Conversation } from "@convoz/api-client";
import { stripCf } from "../../shared/chat.ts";

export interface Groups {
  starred: Conversation[];
  mid: Conversation[];
  older: Conversation[];
}

/** A section keeps the owner's order: the higher rank first, activity never matters (I-21). */
export const byRank = (a: Conversation, b: Conversation): number => b.rank - a.rank || b.id - a.id;
export const byActivity = (a: Conversation, b: Conversation): number => b.last_activity_at - a.last_activity_at || b.id - a.id;

/**
 * groups splits the list into Starred, Conversations and Older. Starred is always in the owner's order; `mid` is in the owner's order on
 * the desktop rail and by latest activity on the phone Chats list (design I-21, the DEFAULT the owner confirms).
 */
export function groups(list: Conversation[], mid: "rank" | "activity"): Groups {
  const order = mid === "rank" ? byRank : byActivity;
  return {
    starred: list.filter((c) => c.starred).sort(byRank),
    mid: list.filter((c) => !c.starred && !c.older).sort(order),
    older: list.filter((c) => !c.starred && c.older).sort(order),
  };
}

export const titleOf = (c: Conversation): string => stripCf(c.title ?? "") || "New conversation";

/** previewOf is the row's second line: who wrote last, then the words. */
export const previewOf = (c: Conversation, me: string): string =>
  c.last ? `${c.last.author_handle === me ? "You" : c.last.author_handle}: ${c.last.preview}` : "No messages yet";

/** The label a screen reader gets for a row, as the prototype words it. */
export const rowLabel = (c: Conversation): string => `${titleOf(c)}${c.muted_until ? ", muted" : ""}${c.unread > 0 ? `, ${c.unread} unread` : ""}`;

/** The mute that never ends (the schema's "forever"). */
export const FOREVER = 253402300799000;
