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
  waiting: { label: "Waiting on you", ring: "amber ring" },
  blocked: { label: "Blocked", ring: "red ring" },
  idle: { label: "Idle", ring: "grey ring" },
  offline: { label: "Offline", ring: "hollow grey dot" },
};

/** shownState folds the stored state and the live session into the one state Crew draws. */
export function shownState(online: boolean | undefined, state: AgentState | undefined): Shown {
  if (!online) return "offline";
  return state === "waiting" || state === "blocked" || state === "working" ? state : "idle";
}

/** The groups of the Crew list, in order. Offline agents sit under Idle: the prototype's list has no group of its own for them. */
export const GROUPS = [
  { key: "waiting", label: "Waiting on you", shown: ["waiting", "blocked"] },
  { key: "working", label: "Working", shown: ["working"] },
  { key: "idle", label: "Idle", shown: ["idle", "offline"] },
] as const;

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
