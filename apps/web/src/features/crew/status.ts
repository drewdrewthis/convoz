import type { Identity } from "@convoz/api-client";
import type { AgentState } from "./types.ts";

/** What the owner sees of an agent: its stored state, unless it has no live session, which is offline whatever it last said. */
export type Shown = "working" | "waiting" | "blocked" | "idle" | "offline";

export interface Look {
  /** The word next to the ring, so state never rests on colour alone. */
  label: string;
  /** What the ring looks like in words; also its accessible name. */
  ring: string;
}

export const LOOK: Record<Shown, Look> = {
  working: { label: "Working", ring: "moving gradient ring" },
  waiting: { label: "Waiting", ring: "amber ring" },
  blocked: { label: "Blocked", ring: "red ring" },
  idle: { label: "Idle", ring: "grey ring" },
  offline: { label: "Offline", ring: "hollow grey dot" },
};

/** shownState folds the stored state and the live session into the one state Crew draws. */
export function shownState(online: boolean | undefined, state: AgentState | undefined): Shown {
  if (!online) return "offline";
  return state === "waiting" || state === "blocked" || state === "working" ? state : "idle";
}

/** labelOf is the word next to the ring: an agent's own "waiting" claim reads "Waiting on you" only when an open ask backs it. */
export const labelOf = (shown: Shown, asks: number): string => (shown === "waiting" && asks > 0 ? "Waiting on you" : LOOK[shown].label);

export type GroupKey = "needs" | "waiting" | "working" | "idle";

/** groupOf files an agent: under "Waiting on you" only with an open ask (blocked or waiting); a bare claim sits under "Waiting". */
export function groupOf(shown: Shown, asks: number): GroupKey {
  if (shown === "waiting" || shown === "blocked") return asks > 0 ? "needs" : "waiting";
  return shown === "working" ? "working" : "idle";
}

/** The groups of the Crew list, in order. Offline agents sit under Idle: the prototype's list has no group of its own for them. */
export const GROUPS: readonly { key: GroupKey; label: string }[] = [
  { key: "needs", label: "Waiting on you" },
  { key: "waiting", label: "Waiting" },
  { key: "working", label: "Working" },
  { key: "idle", label: "Idle" },
];

/** nameOf is "Search Dev @dev-search"; the handle alone when the display name only repeats it (I-3). */
export const sameName = (p: Pick<Identity, "handle" | "display_name">): boolean => p.display_name.toLowerCase() === p.handle.toLowerCase();

/** ago says how long ago in the short form of the prototype: "just now", "2 min ago", "3 h ago", "4 d ago". */
export function ago(ms: number, now = Date.now()): string {
  const min = Math.max(0, Math.floor((now - ms) / 60_000));
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  if (min < 1440) return `${Math.floor(min / 60)} h ago`;
  return `${Math.floor(min / 1440)} d ago`;
}
