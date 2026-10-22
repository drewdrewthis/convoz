import type { OwnerIntent } from "./guard.ts";

/**
 * What the tools need from the page: the agents the call may name and the owner's own way to read and post. A call in a conversation
 * has `post`; a Now call has `now` and no `post`, so nothing in it writes even if the model asks for a tool its token does not offer.
 */
export interface ToolDeps {
  intent: OwnerIntent;
  /** The handles of the agents the call may name: those of the conversation, or every agent in a Now call. */
  agents(): string[];
  /** Post "@handle text" as the owner, marked "via voice call". */
  post?(handle: string, text: string): Promise<void>;
  /** The last n messages of the conversation; a Now call names which one. */
  recent(n: number, conversation?: number): Promise<{ author: string; text: string }[]> | { author: string; text: string }[];
  status(handle: string): { handle: string; online: boolean };
  /** What waits for the owner (GET /api/now), cut down for the model. */
  now?(): Promise<Record<string, unknown>>;
}

export interface ToolResult {
  /** The tool's answer to the model. */
  response: Record<string, unknown>;
  /** What the call line says, when the tool did something the owner should see ("Asked @dot"). */
  cue?: string;
}

const MOST_TEXT = 2000;

/**
 * The tools that write. Each runs only when the owner's own speech is the latest input to the model (OwnerIntent). The triage call
 * has none yet; its next ones (answer an ask once the owner says yes, post, assign) join this set and get their deps here.
 */
export const WRITES = new Set(["ask_agent"]);
const clean = (h: unknown): string => String(h ?? "").trim().replace(/^@/, "").toLowerCase();

/**
 * runTool runs one tool the model asked for, with the owner's session. ask_agent is the only one that writes, and it writes only when
 * the owner's own speech is the latest input to the model (OwnerIntent) and the agent is in this conversation. Its answer is the
 * model's only way to learn of a refusal.
 */
export async function runTool(deps: ToolDeps, name: string, args: Record<string, unknown> | undefined): Promise<ToolResult> {
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
      const n = Math.min(20, Math.max(1, Math.trunc(Number(args?.n)) || 5));
      const conversation = Math.trunc(Number(args?.conversation_id)) || undefined;
      try {
        return { response: { messages: await deps.recent(n, conversation) } };
      } catch {
        return { response: { error: "could not read" } };
      }
    }
    case "read_now": {
      if (!deps.now) return { response: { error: "no such tool" } };
      try {
        return { response: await deps.now() };
      } catch {
        return { response: { error: "could not read" } };
      }
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
