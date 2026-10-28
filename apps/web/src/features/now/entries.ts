import type { Ask, NowWaiting } from "@convoz/api-client";

export type Entry = { at: number; ask: Ask } | { at: number; plan: NowWaiting };

/** entries are the asks and the plan items that wait on the owner, newest first. */
export function entries(asks: readonly Ask[], waiting: readonly NowWaiting[]): Entry[] {
  return [...asks.map((ask) => ({ at: ask.created_at, ask })), ...waiting.map((plan) => ({ at: plan.since, plan }))].sort((a, b) => b.at - a.at);
}
