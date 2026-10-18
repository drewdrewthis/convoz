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

/**
 * isOlder is the prototype v41 rule: not starred, and no message since yesterday (its last activity is before this morning, in the
 * owner's own time zone). A new conversation with no message yet was made today, so it is never Older.
 */
export function isOlder(c: Conversation, now = Date.now()): boolean {
  const morning = new Date(now).setHours(0, 0, 0, 0);
  return !c.starred && c.last_activity_at < morning;
}

/** groups splits the list into Starred, Conversations and Older. Every group is in the owner's order (desktop and phone alike). */
export function groups(list: Conversation[]): Groups {
  return {
    starred: list.filter((c) => c.starred).sort(byRank),
    mid: list.filter((c) => !c.starred && !isOlder(c)).sort(byRank),
    older: list.filter((c) => isOlder(c)).sort(byRank),
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
