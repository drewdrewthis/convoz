// The one plain-text form of a message (docs/messages-apps-spec.md §2.3, E-21). apps/convoz/internal/server/message/project.go is
// its twin; both run packages/contracts/fixtures/projection/*.json (AC-M1), so a change here is a change there.
import { tokenizeV2 } from "./v2.ts";

export type ProjectForm = "short" | "long";

export interface Person {
  handle: string;
  name: string;
}
export interface Upload {
  kind: "audio" | "image" | "file";
  name: string;
  size: number;
  duration_ms: number;
}
/** Everything the projection reads. The variant is derived in the fixed order of the spec: deleted, system, ask, answer, via_app, app, voice, image, file, text. */
export interface Projectable {
  deleted?: boolean;
  system?: {
    t: string;
    identity: Person;
    by: Person;
    history?: string;
    streak?: number;
    title?: string;
    from?: string;
    to?: string;
    done?: string;
    now?: string;
    waiting?: string;
    liveness?: string;
  } | null;
  ask?: { question: string; options: { label: string; why: string }[] } | null;
  answer?: { custom: boolean; text: string } | null;
  via_app?: Person | null;
  app?: { title: string; fallback: string } | null;
  format?: "markdown" | "markdownv2" | "plain";
  body?: string;
  uploads?: Upload[];
  transcript?: string;
  reply?: boolean;
}

const SHORT_CHARS = 140;
const LONG_CHARS = 4000;
const SPACE = "\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const SPACES = new RegExp(`[${SPACE}]+`);
const trim = (s: string) => s.replace(new RegExp(`^[${SPACE}]+|[${SPACE}]+$`, "g"), "");

const ref = (p: Person) => (p.name === "" || p.name.toLowerCase() === p.handle.toLowerCase() ? `@${p.handle}` : `${p.name} @${p.handle}`);

function systemText(s: NonNullable<Projectable["system"]>): string {
  switch (s.t) {
    case "member.added":
      return s.history === "full" ? `Added ${ref(s.identity)} · full history` : `Added ${ref(s.identity)}`;
    case "member.requested":
      return `${ref(s.by)} wants to add ${ref(s.identity)}`;
    case "member.approved":
      return `Approved · ${ref(s.identity)} added`;
    case "member.declined":
      return `Declined · ${ref(s.identity)} not added`;
    case "member.removed":
      return `${ref(s.identity)} was removed`;
    case "member.left":
      return `${ref(s.identity)} left`;
    case "member.disabled":
      return `${ref(s.identity)} was disabled`;
    case "member.renamed":
      return `@${s.from ?? ""} is now @${s.to ?? ""}`;
    case "conversation.renamed":
      return s.title ? `${ref(s.by)} renamed this to "${s.title}"` : `${ref(s.by)} renamed the conversation`;
    case "conversation.paused":
      return `Paused after ${s.streak ?? 0} agent messages in a row. Resume to let agents post.`;
    case "conversation.resumed":
      return `${ref(s.by)} resumed the conversation`;
    case "conversation.restored":
      return `${ref(s.by)} restored this conversation from Trash`;
    case "plan.changed": {
      const parts: [string, string | undefined][] = [["Done: ", s.done], ["Now: ", s.now], ["Waiting on you: ", s.waiting]];
      return parts.reduce((text, [label, item]) => (item ? `${text} · ${label}${item}` : text), ref(s.identity));
    }
    case "agent.unresponsive":
      return s.liveness === "logged_out" ? `${ref(s.identity)} is logged out` : `${ref(s.identity)} is not responding`;
  }
  return "";
}

function askText(a: NonNullable<Projectable["ask"]>, form: ProjectForm): string {
  if (form === "short") return `Ask: ${a.question}`;
  const lines = [`Ask: ${a.question}`];
  a.options.forEach((o, i) => lines.push(`${i === 0 ? "*" : "-"} ${i === 0 ? `${o.label} (recommended)` : o.label} — ${o.why}`));
  return lines.join("\n");
}

const clock = (ms: number) => {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

function sizeText(n: number): string {
  if (n >= 1 << 20) return `${Math.floor((n + (1 << 19)) / (1 << 20))} MB`;
  if (n >= 1 << 10) return `${Math.floor((n + (1 << 9)) / (1 << 10))} KB`;
  return `${n} B`;
}

const P_IMAGE = /!\[[^[\]\n]*\]\([^() \t\n]+\)/g;
const P_LINK = /\[([^[\]\n]+)\]\(([^() \t\n]+)\)/g;
const P_CODE = /`([^`\n]+)`/g;
const P_BOLD = /\*\*([^*\n]+)\*\*/g;
const P_ITALIC = /\*([^* \t\n](?:[^*\n]*[^* \t\n])?)\*/g;
const P_STRIKE = /~~([^~\n]+)~~/g;
const P_SPOILER = /\|\|[^|\n]+\|\|/g;
const P_HEADING = /^[ \t]{0,3}#{1,6}[ \t]+/;
const P_QUOTE = /^[ \t]{0,3}>[ \t]?/;
const P_BULLET = /^[ \t]{0,3}[-*+][ \t]+/;
const P_FENCE = /^[ \t]{0,3}```/;
const P_HOST = /^https?:\/\/(?:[^/?#@]*@)?([^/?#:]+)/;
const ONE_PRE = new RegExp(`^[${SPACE}\\ufeff]{0,3}\`\`\`[^\\n\\r\\u2028\\u2029]*\`\`\`[${SPACE}\\ufeff]*$`);

function linkText(label: string, url: string): string {
  const h = P_HOST.exec(url);
  return h ? `${label} (${h[1]!.toLowerCase()})` : label;
}

const lines = (body: string) => body.replace(/\r\n?/g, "\n").split("\n");

function mdText(body: string): string {
  const out: string[] = [];
  let inFence = false;
  for (let line of lines(body)) {
    if (P_FENCE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      out.push(line);
      continue;
    }
    line = line.replace(P_HEADING, "").replace(P_QUOTE, "").replace(P_BULLET, "- ");
    line = line.replace(P_IMAGE, "[image]").replace(P_LINK, (_m, label: string, url: string) => linkText(label, url));
    line = line.replace(P_CODE, "$1").replace(P_BOLD, "$1").replace(P_ITALIC, "$1").replace(P_STRIKE, "$1").replace(P_SPOILER, "[spoiler]");
    out.push(line);
  }
  return out.join("\n");
}

function v2Line(text: string): string {
  let out = "";
  for (const t of tokenizeV2(text)) {
    if (t.kind === "text") out += t.text;
    else if (t.kind === "code") out += t.text;
    else if (t.kind === "link") out += linkText(t.label, t.url);
    else out += t.style === "spoiler" ? "[spoiler]" : t.text;
  }
  return out;
}

function v2Text(body: string): string {
  const out: string[] = [];
  let inFence = false;
  for (const line of lines(body)) {
    if (P_FENCE.test(line)) {
      if (!ONE_PRE.test(line)) inFence = !inFence;
      else out.push(trim(trim(line).slice(3, -3)));
      continue;
    }
    out.push(inFence ? line : v2Line(line.replace(P_QUOTE, "")));
  }
  return out.join("\n");
}

function textOf(m: Projectable): string {
  const body = m.body ?? "";
  if (m.format === "plain") return body;
  return m.format === "markdownv2" ? v2Text(body) : mdText(body);
}

function uploadsText(m: Projectable, form: ProjectForm, label: string, many: string): string {
  const ups = m.uploads!;
  if (form === "short") return ups.length === 1 ? `${label} · ${ups[0]!.name}` : `${ups.length} ${many}`;
  const caption = trim(textOf(m));
  let tag: string;
  if (ups.length > 1) tag = `[${ups.length} ${many}]`;
  else if (label === "File") tag = `[File: ${ups[0]!.name}, ${sizeText(ups[0]!.size)}]`;
  else tag = `[Image: ${ups[0]!.name}]`;
  return trim(`${caption} ${tag}`);
}

function voiceText(m: Projectable, form: ProjectForm): string {
  const t = clock(m.uploads![0]!.duration_ms);
  if (form === "short") return `Voice note · ${t}`;
  return m.transcript ? `Voice note ${t}: ${m.transcript}` : `Voice note ${t}`;
}

function appText(m: Projectable, form: ProjectForm): string {
  const a = m.app!;
  if (form === "short") return `App: ${a.title} — ${a.fallback}`;
  const body = trim(textOf(m));
  const card = `[App: ${a.title}] ${a.fallback}`;
  return body ? `${body}\n${card}` : card;
}

function clean(text: string, form: ProjectForm): string {
  text = text.replace(/\p{Cf}/gu, "");
  if (form === "short") return text.split(SPACES).filter(Boolean).join(" ");
  const ls = text.split("\n").map((l) => l.replace(/[ \t]+$/, ""));
  return trim(ls.join("\n").replace(/\n{3,}/g, "\n\n"));
}

function cut(text: string, form: ProjectForm): string {
  const chars = Array.from(text);
  const n = form === "short" ? SHORT_CHARS : LONG_CHARS;
  return chars.length <= n ? text : chars.slice(0, n).join("");
}

/** project turns a message into its plain text, short (one line, 140 characters) or long (4000). */
export function project(m: Projectable, form: ProjectForm): string {
  let text: string;
  const ups = m.uploads ?? [];
  if (m.deleted) text = "Message deleted";
  else if (m.system) text = systemText(m.system);
  else if (m.ask) text = askText(m.ask, form);
  else if (m.answer) text = (m.answer.custom ? "Replied: " : "Answered: ") + m.answer.text;
  else if (m.via_app) text = `${trim(textOf(m))} (via app by ${ref(m.via_app)})`;
  else if (m.app) text = appText(m, form);
  else if (ups.length === 1 && ups[0]!.kind === "audio") text = voiceText(m, form);
  else if (ups.length > 0 && ups.every((u) => u.kind === "image")) text = uploadsText(m, form, "Image", "images");
  else if (ups.length > 0) text = uploadsText(m, form, "File", "files");
  else text = textOf(m);
  if (m.reply && form === "short" && !m.deleted) text = `↳ ${text}`;
  return cut(clean(text, form), form);
}


