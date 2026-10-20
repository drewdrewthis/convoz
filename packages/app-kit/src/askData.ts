import type { DraftData } from "./DraftReview.tsx";

/* What an ask card is drawn from, and how it names its people and its state.
 * The types are local on purpose: this package knows no API client, so the app maps its data to these shapes. */

export interface AskPerson {
  handle: string;
  display_name: string;
  kind: string;
}

export interface AskHistoryItem {
  event: string;
  by?: AskPerson;
  at: number;
}

export interface AskData {
  question: string;
  urgent: boolean;
  /** Why only the owner can decide. Absent on an ask from before the field. */
  owners_call?: { kind: string; reason: string };
  state: string;
  close_reason?: string;
  options: { label: string; why: string }[];
  /** A draft ask: a message to send in the owner's name. It is answered with Send (the final text) or Don't send. */
  draft?: DraftData;
  chosen?: { kind: string };
  answer?: string;
  created_at: number;
  asker: AskPerson;
  conversation?: { title: string | null };
  history?: AskHistoryItem[];
}

export interface SnoozePreset {
  key: string;
  label: string;
}

export interface Answer {
  choice: "recommended" | "alternative" | "custom";
  index?: number;
  text?: string;
}

/** whoLine is how a person is named: "Drew", or "Devtool @devtool" for an agent (an agent is never shown by its name alone). */
export function whoLine(p: AskPerson): string {
  if (p.kind === "agent") return p.display_name ? `${p.display_name} @${p.handle}` : `@${p.handle}`;
  return p.display_name || `@${p.handle}`;
}

export const clock = (at: number) => new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

/** stateLine says where a closed ask stands, or "" for an open one. */
export function stateLine(a: AskData): string {
  switch (a.state) {
    case "answered":
      return `${a.chosen?.kind === "custom" ? "Replied" : "Answered"} · ${a.answer ?? ""}`;
    case "dismissed":
      return "Dismissed";
    case "closed":
      return a.close_reason === "replied" ? "Answered with a reply" : "Closed";
  }
  return "";
}

const HISTORY: Record<string, string> = { create: "Asked", answer: "Answered", dismiss: "Dismissed", undismiss: "Reopened", withdraw: "Withdrawn", close: "Closed" };

/** historyText is one line of the History list: "Answered by Drew · Yes". */
export function historyText(h: AskHistoryItem, a: AskData): string {
  const who = h.by ? ` by ${whoLine(h.by)}` : "";
  return `${HISTORY[h.event] ?? h.event}${who}${h.event === "answer" && a.answer ? ` · ${a.answer}` : ""}`;
}
