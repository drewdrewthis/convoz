import type { Ask, FeedItem, NowWaiting } from "@convoz/api-client";
import type { Fyi } from "./feed.ts";

/** One feed item. blocking: waits on the owner. fyi: the owner only needs to know (a step started, or done) (owner, conv 179 msg 11623: one list, one item shape). */
export type Entry = { at: number; ask: Ask } | { at: number; plan: NowWaiting } | { at: number; fyi: Fyi } | { at: number; item: FeedItem };

/** entries are the blocking asks and plan steps and the fyi updates in one list, newest first. */
export function entries(asks: readonly Ask[], waiting: readonly NowWaiting[], done: readonly Fyi[] = [], items: readonly FeedItem[] = []): Entry[] {
  return [...asks.map((ask) => ({ at: ask.created_at, ask })), ...waiting.map((plan) => ({ at: plan.since, plan })), ...done.map((f) => ({ at: f.at, fyi: f })), ...items.map((item) => ({ at: item.updated_at, item }))].sort((a, b) => b.at - a.at);
}

/** shown are the items that are cards: not pending (those are listed under the step that is now), not snoozed, and an fyi that was not acknowledged. */
export function shown(items: readonly FeedItem[], now: number): FeedItem[] {
  return items.filter((i) => i.state !== "pending" && i.state !== "dropped" && !i.acked_at && !(i.snoozed_until && i.snoozed_until > now));
}

/** nextOf are the titles of the pending steps of the same agent in the same conversation, in plan order. */
export function nextOf(items: readonly FeedItem[], item: FeedItem): string[] {
  return items.filter((n) => n.state === "pending" && n.agent_id === item.agent_id && n.conversation_id === item.conversation_id).sort((a, b) => a.seq - b.seq).map((n) => n.title);
}
