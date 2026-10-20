import type { OwnerIntent } from "./guard.ts";

/** What the tools need from the page: the people of the conversation and the owner's own way to post and read. */
export interface ToolDeps {
  intent: OwnerIntent;
  /** The handles of the agents in this conversation. */
  agents(): string[];
  /** Post "@handle text" as the owner, marked "via voice call". */
  post(handle: string, text: string): Promise<void>;
  recent(n: number): { author: string; text: string }[];
  status(handle: string): { handle: string; online: boolean };
}

export interface ToolResult {
  /** The tool's answer to the model. */
  response: Record<string, unknown>;
  /** What the call line says, when the tool did something the owner should see ("Asked @dot"). */
  cue?: string;
}

const MOST_TEXT = 2000;
const clean = (h: unknown): string => String(h ?? "").trim().replace(/^@/, "").toLowerCase();

/**
 * runTool runs one tool the model asked for, with the owner's session. ask_agent is the only one that writes, and it writes only when
 * the owner's own speech is the latest input to the model (OwnerIntent) and the agent is in this conversation. Its answer is the
 * model's only way to learn of a refusal.
 */
export async function runTool(deps: ToolDeps, name: string, args: Record<string, unknown> | undefined): Promise<ToolResult> {
  switch (name) {
    case "ask_agent": {
      if (!deps.intent.allows()) return { response: { error: "refused: only the owner can ask" } };
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
      return { response: { messages: deps.recent(n) } };
    }
    case "agent_status": {
      const handle = clean(args?.handle);
      const agent = deps.agents().find((a) => a.toLowerCase() === handle);
      return { response: agent ? deps.status(agent) : { error: "not in this conversation" } };
    }
    default:
      return { response: { error: "no such tool" } };
  }
}
