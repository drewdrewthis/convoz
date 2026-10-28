import type { Ask, NowWaiting, ShippedDelivery } from "@convoz/api-client";

/** One feed item. blocking: waits on the owner. fyi: the owner only needs to know (owner, conv 179 msg 11623: one list, one item shape). */
export type Entry = { at: number; ask: Ask } | { at: number; plan: NowWaiting } | { at: number; done: ShippedDelivery };

/** entries are the blocking asks and plan steps and the fyi updates in one list, newest first. */
export function entries(asks: readonly Ask[], waiting: readonly NowWaiting[], done: readonly ShippedDelivery[] = []): Entry[] {
  return [...asks.map((ask) => ({ at: ask.created_at, ask })), ...waiting.map((plan) => ({ at: plan.since, plan })), ...done.map((d) => ({ at: d.at, done: d }))].sort((a, b) => b.at - a.at);
}
