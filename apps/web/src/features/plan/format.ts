// How a plan reads: the line under a title, the dot of a row and the times of the panel. Times are the owner's, in this browser's
// time zone; "~" marks an estimate. Every "now" is the server's (see usePlans().skew).
import type { PlanAttention } from "@convoz/api-client";

export type Tone = "green" | "amber" | "red" | "grey";

const MIN = 60_000;
const DAY = 24 * 60 * MIN;

/** The wall time of an instant: "11:30". */
export const clock = (ms: number): string => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

const dayStart = (ms: number) => new Date(ms).setHours(0, 0, 0, 0);

/** The day of an instant as the Done list groups it: "Today", "Yesterday", or "Mon 12 Oct". */
export function dayLabel(ms: number, now: number): string {
  const days = Math.round((dayStart(now) - dayStart(ms)) / DAY);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  return new Date(ms).toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" });
}

/** A time that may not be today: "11:30", or "Tue 11:30". */
export function when(ms: number, now: number): string {
  return dayStart(ms) === dayStart(now) ? clock(ms) : `${new Date(ms).toLocaleDateString([], { weekday: "short" })} ${clock(ms)}`;
}

/** How long, in words: "15 min", "2 h", "3 days". */
export function span(ms: number): string {
  const m = Math.max(1, Math.round(ms / MIN));
  if (m < 60) return `${m} min`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h} h` : `${Math.round(h / 24)} days`;
}

/** "4 min ago", or "just now". */
export const ago = (ms: number, now: number): string => (now - ms < MIN ? "just now" : `${span(now - ms)} ago`);

interface Look {
  text: string;
  tone: Tone;
}

/** The line under a conversation's title, and the tone of its dot. */
export function lineOf(a: PlanAttention, now: number): Look {
  const look = oneLine(a, now);
  return a.more ? { ...look, text: `${look.text} +${a.more}` } : look; // "+n": the plan has n more Now items than the line shows
}

function oneLine(a: PlanAttention, now: number): Look {
  switch (a.state) {
    case "waiting":
      return { text: `Waiting on you: ${a.text}`, tone: "amber" };
    case "blocked":
      return { text: `Blocked: ${a.text}`, tone: "red" };
    case "not_responding":
      return { text: `Not responding · last seen ${a.last_seen_at ? ago(a.last_seen_at, now) : "never"}`, tone: "amber" };
    case "logged_out":
      return { text: `Logged out · @${a.handle}`, tone: "amber" };
    case "late":
      return { text: `Behind · was due ${when(a.eta ?? now, now)}`, tone: "amber" };
    case "stale":
      return { text: `${a.text} · no update for 2 h`, tone: "grey" };
    case "working":
      return { text: `Working · ${a.text}${a.eta ? ` · ready ~${when(a.eta, now)}` : ""}`, tone: "green" };
    case "next":
      return { text: `Next · ${a.text}`, tone: "grey" };
  }
  return { text: "Done · nothing planned", tone: "grey" };
}

/** The dot of a Conversations row and its name; null when the conversation is quiet (nothing going on, or all done). */
export function dotOf(a: PlanAttention | undefined): { label: string; tone: Tone } | null {
  switch (a?.state) {
    case "working":
      return { label: "Working", tone: "green" };
    case "waiting":
      return { label: "Waiting on you", tone: "amber" };
    case "late":
      return { label: "Behind", tone: "amber" };
    case "stale":
      return { label: "No update", tone: "amber" };
    case "not_responding":
      return { label: "Not responding", tone: "amber" };
    case "logged_out":
      return { label: "Logged out", tone: "amber" };
    case "blocked":
      return { label: "Blocked", tone: "red" };
  }
  return null;
}
