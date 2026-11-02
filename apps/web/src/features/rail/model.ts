// What the rail shows, worked out from the conversation list: the three groups, their order and a row's words.
import type { Conversation } from "@convoz/api-client";
import { stripCf } from "../../shared/chat.ts";

export interface Groups {
  starred: Conversation[];
  mid: Conversation[];
  older: Conversation[];
}

/** A section keeps the owner's order: the higher rank first; a new message puts an unstarred conversation back on top (its rank is its last activity) (I-21). */
export const byRank = (a: Conversation, b: Conversation): number => b.rank - a.rank || b.id - a.id;

/** How long a conversation may go without a message before it folds into Older (Drew, 2026-10-22). */
export const OLDER_AFTER_MS = 48 * 3_600_000;

/**
 * isOlder: not starred, and either marked stale since its last message (an agent did, or the owner closed it from the row menu; the
 * server says so in `stale`; the next message clears it) or quiet for 48 hours while the owner did not write the newest message
 * (that one waits on the agents, #42). A new conversation with no message yet counts from when it was made.
 */
export function isOlder(c: Conversation, now = Date.now()): boolean {
  return !c.starred && (c.stale === true || (!c.owner_last && Math.max(c.last_activity_at, c.back_at ?? 0) < now - OLDER_AFTER_MS));
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
export const rowLabel = (c: Conversation, n = c.main_unread ?? c.unread): string => `${titleOf(c)}${c.muted_until ? ", muted" : ""}${n > 0 ? `, ${n} unread` : ""}`;

/** The mute that never ends (the schema's "forever"). */
export const FOREVER = 253402300799000;
