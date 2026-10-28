import type { Ask, NowWaiting } from "@convoz/api-client";
import type { Fyi } from "./feed.ts";

/** One feed item. blocking: waits on the owner. fyi: the owner only needs to know (a step started, or done) (owner, conv 179 msg 11623: one list, one item shape). */
export type Entry = { at: number; ask: Ask } | { at: number; plan: NowWaiting } | { at: number; fyi: Fyi };

/** entries are the blocking asks and plan steps and the fyi updates in one list, newest first. */
export function entries(asks: readonly Ask[], waiting: readonly NowWaiting[], done: readonly Fyi[] = []): Entry[] {
  return [...asks.map((ask) => ({ at: ask.created_at, ask })), ...waiting.map((plan) => ({ at: plan.since, plan })), ...done.map((f) => ({ at: f.at, fyi: f }))].sort((a, b) => b.at - a.at);
}
