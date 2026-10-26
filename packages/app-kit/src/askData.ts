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

/** The parts of a permission ask: one action the agent is sure of, what it risks and how to undo it, and the ways it turned down. */
export interface AskPermission {
  action: string;
  risk: string;
  undo?: string;
  one_way?: boolean;
  considered: string[];
  /** What the agent said it was, 0-100. Self-reported, not a check: only History shows it. */
  confidence: number;
}

export interface AskData {
  kind?: "permission" | "decision" | "draft";
  /** Present on a permission ask: the card then reads as a request for the owner's OK. */
  permission?: AskPermission;
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
  /** The owner's latest reply in the thread of this open ask: it waits on the agent's updated ask. */
  owner_reply?: { text: string };
  /** The summary of the answers to the owner's questions that the latest update of the ask carries. */
  answers?: string;
  /** 2 after the first update, 3 after the next; absent on an ask never updated. */
  revision?: number;
  /** What the latest update changed: "question, options". */
  changed?: string;
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

/** waitingLine is the line of an open ask the owner replied to: "You replied · waiting on @devtool". */
export const waitingLine = (a: AskData): string => `You replied · waiting on @${a.asker.handle}`;

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

const HISTORY: Record<string, string> = { create: "Asked", answer: "Answered", dismiss: "Dismissed", undismiss: "Reopened", withdraw: "Withdrawn", close: "Closed", owner_replied: "Replied in the thread", updated: "Updated" };

/** historyText is one line of the History list: "Answered by Drew · Yes", "Updated by Devtool @devtool · v2, changed answers". */
export function historyText(h: AskHistoryItem, a: AskData): string {
  const who = h.by ? ` by ${whoLine(h.by)}` : "";
  if (h.event === "create" && a.permission) return `Asked${who} · said ${a.permission.confidence}% sure`;
  return `${HISTORY[h.event] ?? h.event}${who}${h.event === "answer" && a.answer ? ` · ${a.answer}` : ""}${h.event === "updated" ? updateTrail(h, a) : ""}`;
}

/** The version an update made (v2 for the first) and, for the latest one only, what it changed: the ask carries only the latest `changed`. */
function updateTrail(h: AskHistoryItem, a: AskData): string {
  const updates = (a.history ?? []).filter((x) => x.event === "updated");
  const n = updates.indexOf(h);
  const latest = n === updates.length - 1;
  return ` · v${n + 2}${latest && a.changed ? `, changed ${a.changed}` : ""}`;
}

/** One question of the owner and the agent's answer to it. Either side can be missing: text before the first mark, or a question left unanswered. */
export interface QaPair {
  q?: string;
  a: string;
}

// A mark starts the text or follows a space, so "FAQ:" or "QA:" inside a sentence is not one.
const MARK = /(?<=^|\s)([QA]):\s*/g;

/**
 * qaPairs splits the answers of an update into the owner's questions and the agent's answers, on their "Q:" and "A:" marks.
 * With no "A:" mark the whole text is one answer, as it was written. With no "Q:" mark the owner's reply in the thread is the question.
 */
export function qaPairs(answers: string, ownerReply?: string): QaPair[] {
  const marks = [...answers.matchAll(MARK)];
  if (!marks.some((m) => m[1] === "A")) return [{ q: ownerReply, a: answers }];
  const pairs: QaPair[] = [];
  const lead = answers.slice(0, marks[0]!.index).trim();
  if (lead) pairs.push({ a: lead });
  let q: string | undefined;
  marks.forEach((m, i) => {
    const body = answers.slice(m.index + m[0].length, marks[i + 1]?.index ?? answers.length).trim();
    if (m[1] === "A") {
      pairs.push({ q, a: body });
      q = undefined;
      return;
    }
    if (q !== undefined) pairs.push({ q, a: "" });
    q = body;
  });
  if (q !== undefined) pairs.push({ q, a: "" });
  if (ownerReply && !marks.some((m) => m[1] === "Q")) pairs[0]!.q ??= ownerReply;
  return pairs;
}
