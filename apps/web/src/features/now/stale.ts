import type { FeedItem } from "@convoz/api-client";

/** The server asks an agent for a status after this long without one (status_due); the mark shows at the same time. */
export const QUIET = 15 * 60_000;

/** staleLine is the quiet line of a started item whose last change is older than 15 minutes: "No update since 9:05 AM". Empty for any other item (owner, conv 179 msg 12699, 12763). */
export function staleLine(item: Pick<FeedItem, "state" | "updated_at">, now: number): string {
  if (item.state !== "started" || now - item.updated_at < QUIET) return "";
  return `No update since ${new Date(item.updated_at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
}
