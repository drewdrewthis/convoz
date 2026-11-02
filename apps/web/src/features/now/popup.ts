import type { Ask, Now } from "@convoz/api-client";
import type { AgentRequest } from "./requests.tsx";

/** One urgent thing the popup can show: a connect request as its Now card draws it, or an urgent ask. */
export type Pop = AgentRequest | { kind: "plain"; key: string; machine: Now["machine_requests"][number] } | { kind: "ask"; key: string; ask: Ask };

/**
 * toPop is what pops, in order, minus what the owner already saw: machine requests, then agents asking to connect from a machine
 * already connected, then the urgent open asks. Connect requests lead because an agent cannot work until the owner approves.
 * Keys match the request cards (`m<id>`, the ref), and `a<id>` for an ask (owner, 2026-10-30: "anything that's urgent should be a popup").
 */
export function toPop(now: Now | null, seen: ReadonlySet<string>): Pop[] {
  if (!now) return [];
  const all: Pop[] = [
    ...now.machine_requests.map((machine): Pop => (machine.identity ? { kind: "login", key: `m${machine.id}`, machine } : { kind: "plain", key: `m${machine.id}`, machine })),
    ...now.identity_requests.map((request): Pop => ({ kind: "session", key: request.ref, request })),
    ...now.asks.filter((a) => a.urgent).map((ask): Pop => ({ kind: "ask", key: `a${ask.id}`, ask })),
  ];
  return all.filter((p) => !seen.has(p.key));
}

/**
 * popsOn says whether the popup shows: not on Now (`/`, `/now/...`), where the requests are already on top, and not while another
 * dialog is open (the Invite agent sheet shows the same request; a popup over it would block it). It pops once that dialog closes.
 */
export const popsOn = (path: string, otherDialog = false): boolean => !otherDialog && path !== "/" && !path.startsWith("/now/");
