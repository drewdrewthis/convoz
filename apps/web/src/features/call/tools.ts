import type { OwnerIntent } from "./guard.ts";
import { READ_DEFAULT, READ_MOST } from "./reads.ts";
import { spoken, type Held, type Planned, type Plans, type Until } from "./writes.ts";

/**
 * What the tools need from the page: the agents the call may name and the owner's own way to read and post. A call in a conversation
 * has `post`; a Now call has `now`, `plans` and `held` and no `post`, so it writes only what the owner said yes to, and never asks an agent.
 */
export interface ToolDeps {
  intent: OwnerIntent;
  /** The handles of the agents the call may name: those of the conversation, or every agent in a Now call. */
  agents(): string[];
  /** Post "@handle text" for the owner, as @voice. */
  post?(handle: string, text: string): Promise<void>;
  /** The last n messages of the conversation (a call in a conversation only). */
  recent?(n: number): { author: string; text: string }[];
  status(handle: string): { handle: string; online: boolean };
  /** What waits for the owner (GET /api/now), cut down for the model. The four reads below are the Now call's (reads.ts). */
  now?(): Promise<Record<string, unknown>>;
  search?(query: string): Promise<Record<string, unknown>>;
  conversations?(): Promise<Record<string, unknown>>;
  conversation?(id: number | undefined, title: string, limit: number): Promise<Record<string, unknown>>;
  /** The Now call's writes (writes.ts) and the one that waits for the owner's yes. */
  plans?: Plans;
  held?: Held;
}

export interface ToolResult {
  /** The tool's answer to the model. */
  response: Record<string, unknown>;
  /** What the call line says, when the tool did something the owner should see ("Asked @dot"). */
  cue?: string;
}

const MOST_TEXT = 2000;
/** The server's search takes at most 200 characters. */
const MOST_QUERY = 200;

/**
 * The triage call's writes. Each plans first, which changes nothing, so it can follow a read ("find X and post Y" is one sentence). It
 * then runs at once when the owner's own words are the latest input to the model (no message text read since, OwnerIntent.spend);
 * otherwise it reads back and holds, and confirm_action runs it only after the owner's yes (writes.ts).
 */
const PLANNED = new Set(["post_message", "reply_in_thread", "answer_ask", "snooze_ask", "mark_stale", "star_conversation", "start_conversation", "message_agent"]);
/**
 * The tools that change something at once. Each runs only when the owner's own speech is the latest input to the model (OwnerIntent):
 * an agent's words (a reply, or a read that returns them) clear it. confirm_action also needs a word from him after the read-back
 * (Held.heardSince).
 */
export const WRITES = new Set(["ask_agent", "confirm_action"]);
/** What a plan tells the model to do next; the server's instruction says the same (voice.go, nowInstruction). */
const READ_BACK = "Say read_back to the owner word for word and wait. Call confirm_action only after he says yes; if he says no, call cancel_action.";
const UNTILS: Until[] = ["1h", "tonight", "tomorrow"];
const clean = (h: unknown): string => String(h ?? "").trim().replace(/^@/, "").toLowerCase();

/**
 * runTool runs one tool the model asked for, with the owner's session. A tool in WRITES runs only when the owner's own speech is the
 * latest input to the model (OwnerIntent); ask_agent names an agent of this conversation, and a triage write only holds until
 * confirm_action. Its answer is the model's only way to learn of a refusal or a failure: it never throws.
 */
export async function runTool(deps: ToolDeps, name: string, args: Record<string, unknown> | undefined): Promise<ToolResult> {
  // Any new write drops the one held before, even one that is refused or names nothing: the owner hears one read-back at a time.
  const turn = PLANNED.has(name) ? deps.held?.drop() : undefined;
  if (WRITES.has(name) && !deps.intent.allows()) return { response: { error: "refused: only the owner can ask" } };
  switch (name) {
    case "ask_agent": {
      if (!deps.post) return { response: { error: "no such tool" } };
      const handle = clean(args?.handle);
      const text = String(args?.text ?? "").trim().slice(0, MOST_TEXT);
      const agent = deps.agents().find((a) => a.toLowerCase() === handle);
      if (!agent) return { response: { error: "not in this conversation" } };
      if (!text) return { response: { error: "nothing to ask" } };
      try {
        await deps.post(agent, text);
      } catch {
        return { response: { error: "could not post" } };
      }
      // The answer is the model's only prompt to speak after a SILENT tool response, so it carries the waiting rule too (waiting.ts).
      return { response: { posted: true, next: `Say one short line like "Sent to @${agent}, waiting", then say nothing until the owner speaks or an AGENT REPLY arrives.` }, cue: `Asked @${agent}` };
    }
    case "read_recent": {
      if (!deps.recent) return { response: { error: "no such tool" } };
      const n = Math.min(20, Math.max(1, Math.trunc(Number(args?.n)) || 5));
      deps.intent.quoted(); // agents' words go to the model
      return { response: { messages: deps.recent(n) } };
    }
    case "read_now":
      return read(deps.intent, deps.now);
    case "list_conversations":
      return read(deps.intent, deps.conversations);
    case "search_messages": {
      const query = String(args?.query ?? "").trim().slice(0, MOST_QUERY);
      return query || !deps.search ? read(deps.intent, deps.search, query) : { response: { error: "nothing to search" } };
    }
    case "read_conversation": {
      const id = Math.trunc(Number(args?.conversation_id)) || undefined;
      const title = String(args?.title ?? "").trim();
      const limit = Math.min(READ_MOST, Math.max(1, Math.trunc(Number(args?.limit)) || READ_DEFAULT));
      return id || title || !deps.conversation ? read(deps.intent, deps.conversation, id, title, limit) : { response: { error: "name the conversation by id or title" } };
    }
    case "post_message": {
      const text = words(args?.text);
      return text ? plan(deps, turn, (p) => p.post(idOf(args?.conversation_id), String(args?.title ?? "").trim(), text)) : { response: { error: "nothing to post" } };
    }
    case "reply_in_thread": {
      const root = idOf(args?.message_id);
      const text = words(args?.text);
      return root && text ? plan(deps, turn, (p) => p.reply(root, text)) : { response: { error: "name the message and the words" } };
    }
    case "start_conversation": {
      const title = String(args?.title ?? "").trim();
      const text = words(args?.text);
      const handles = agentsOf(deps, args?.agents);
      if (!handles) return { response: { error: "no such agent" } };
      return title && text ? plan(deps, turn, (p) => p.start(title, handles, text)) : { response: { error: "name the conversation and the first message" } };
    }
    case "message_agent": {
      const handle = agentsOf(deps, [args?.handle])?.[0];
      const text = words(args?.text);
      if (!handle) return { response: { error: "no such agent" } };
      return text ? plan(deps, turn, (p) => p.messageAgent(handle, text)) : { response: { error: "nothing to say" } };
    }
    case "answer_ask": {
      const ask = idOf(args?.ask_id);
      const option = idOf(args?.option) ?? 0;
      const text = words(args?.text);
      return ask && (option || text) ? plan(deps, turn, (p) => p.answer(ask, option, text)) : { response: { error: "name the ask and the option or the words" } };
    }
    case "snooze_ask": {
      const ask = idOf(args?.ask_id);
      const until = UNTILS.find((u) => u === args?.until);
      if (!until) return { response: { error: 'say how long: "1h", "tonight" or "tomorrow"' } };
      return ask ? plan(deps, turn, (p) => p.snooze(ask, until)) : { response: { error: "name the ask" } };
    }
    case "mark_stale":
      return plan(deps, turn, (p) => p.stale(idOf(args?.conversation_id), String(args?.title ?? "").trim()));
    case "star_conversation": {
      const on = args?.starred;
      if (typeof on !== "boolean") return { response: { error: "say star or unstar: starred true or false" } };
      return plan(deps, turn, (p) => p.star(idOf(args?.conversation_id), String(args?.title ?? "").trim(), on));
    }
    case "confirm_action": {
      if (!deps.held) return { response: { error: "no such tool" } };
      // The read-back is still held: the model says it to him and waits; only his own word after it makes this his yes.
      if (deps.held.waiting && !deps.held.heardSince(deps.intent.spoken)) return { response: { error: "refused: the owner has not said yes since the read-back" } };
      const held = deps.held.take();
      if (!held) return { response: { error: "nothing waits for a yes" } };
      try {
        const done = await held.run();
        return { response: { done }, cue: done };
      } catch (err) {
        return { response: { error: spoken(err) } };
      }
    }
    case "cancel_action": {
      if (!deps.held) return { response: { error: "no such tool" } };
      const had = deps.held.waiting;
      deps.held.drop();
      return { response: { cancelled: had } };
    }
    case "agent_status": {
      const handle = clean(args?.handle);
      const agent = deps.agents().find((a) => a.toLowerCase() === handle);
      return { response: agent ? deps.status(agent) : { error: deps.now ? "no such agent" : "not in this conversation" } };
    }
    default:
      return { response: { error: "no such tool" } };
  }
}

/**
 * read runs one read the call offers; a read this call does not offer is no such tool, and a failed one says so. What it returns holds
 * agents' words (messages, asks, titles), so like an AGENT REPLY it clears the owner's order (OwnerIntent.quoted).
 */
async function read<A extends unknown[]>(intent: OwnerIntent, run: ((...a: A) => Promise<Record<string, unknown>>) | undefined, ...args: A): Promise<ToolResult> {
  if (!run) return { response: { error: "no such tool" } };
  try {
    const response = await run(...args);
    intent.quoted();
    return { response };
  } catch {
    return { response: { error: "could not read" } };
  }
}

/** The known agents a tool names, as the deps spell them; null when any name is not an agent. */
function agentsOf(deps: ToolDeps, named: unknown): string[] | null {
  const known = deps.agents();
  const found = (Array.isArray(named) ? named : []).map((h) => known.find((a) => a.toLowerCase() === clean(h)));
  return found.every((a): a is string => Boolean(a)) ? found : null;
}

const idOf = (v: unknown): number | undefined => Math.trunc(Number(v)) || undefined;
/** Not cut: a plan refuses words too long to read back whole (writes.ts MOST_SAID). */
const words = (v: unknown): string => String(v ?? "").trim();

/**
 * plan reads what one write names. If the owner's own words are still the latest input to the model it runs at once and the model gets
 * what was done to say; otherwise the owner hears the read-back and the write is held for his yes. A failed read says why in words, and
 * holds nothing. `turn` is the one runTool dropped into, so a cancel that came during the read wins.
 */
async function plan(deps: ToolDeps, turn: number | undefined, make: (p: Plans) => Promise<Planned>): Promise<ToolResult> {
  if (!deps.plans || !deps.held || turn === undefined) return { response: { error: "no such tool" } };
  try {
    const planned = await make(deps.plans);
    if (deps.intent.spend()) {
      const done = await planned.run();
      return { response: { done, next: "Tell the owner what was done in one short sentence. Do not ask him to confirm." }, cue: done };
    }
    if (!deps.held.hold(turn, planned, deps.intent.spoken)) return { response: { error: "dropped: a newer word from the owner came first" } };
    return { response: { pending: true, read_back: planned.readBack, next: READ_BACK } };
  } catch (err) {
    return { response: { error: spoken(err) } };
  }
}
