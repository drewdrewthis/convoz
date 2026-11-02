import type { Now } from "@convoz/api-client";

/**
 * arrivals is the toast line for each ask and connect request in `next` that `prev` did not hold: asks, then machine requests,
 * then agents asking to connect from a machine already connected. With no `prev` (the first load) nothing is new: what waited
 * before the page opened is already in Now (owner, 2026-10-30: "there should be toast notifications").
 */
export function arrivals(prev: Now | undefined, next: Now): string[] {
  if (!prev) return [];
  const asks = new Set(prev.asks.map((a) => a.id));
  const machines = new Set(prev.machine_requests.map((m) => m.id));
  const agents = new Set(prev.identity_requests.map((r) => r.ref));
  return [
    ...next.asks.filter((a) => !asks.has(a.id)).map((a) => `@${a.asker.handle} asks: ${a.question}`),
    ...next.machine_requests.filter((m) => !machines.has(m.id)).map((m) => (m.identity ? `${m.name} wants to connect as @${m.identity.handle}` : `${m.name} wants to connect`)),
    ...next.identity_requests.filter((r) => !agents.has(r.ref)).map((r) => `${r.machine} wants to connect as @${r.handle}`),
  ];
}

/** arrivalToast is the one toast for the new lines, or null for none: a toast replaces the one before it, so several share one. */
export function arrivalToast(lines: string[]): string | null {
  if (lines.length < 2) return lines[0] ?? null;
  return `${lines.length} new: ${lines[0]} (+${lines.length - 1} more)`;
}
