import type { Message, Person } from "@convoz/api-client";
import { call, client } from "../../shared/api.ts";
import { newId } from "../../shared/chat.ts";
import { data } from "../../shared/data.ts";
import { useThreads } from "../threads/index.ts";

export interface AppResult {
  v: 1;
  source: "picker" | "checklist" | "form" | "frame";
  summary: string;
  value: unknown;
}

export interface Target {
  conversation: number;
  /** The app message the result comes from, and the agent that wrote it. */
  message: number;
  agent: Person;
  /** The thread the app message is in; absent for a message of the main list (the result goes to the main list too). */
  threadRoot?: number;
}

/**
 * sendViaApp posts the owner's result of an app as a via_app message (I-46). It is called only from a trusted tap in the host
 * (a Tier-1 component's tap, or Send on the host sheet); the server sets the body, the attribution and the loop rule.
 */
export async function sendViaApp(t: Target, result: AppResult): Promise<void> {
  const sent = await call(
    client.POST("/api/conversations/{id}/messages", {
      params: { path: { id: t.conversation } },
      body: { client_id: newId(), via_app: { message_id: t.message, result }, ...(t.threadRoot ? { thread_root_id: t.threadRoot } : {}) },
    }),
  );
  const me = data.store.getState().me!.identity;
  const made: Message = {
    id: sent.id,
    author: { handle: me.handle, display_name: me.display_name, kind: "human" },
    body: result.summary,
    format: "plain",
    created_at: sent.created_at,
    via_app: { message_id: t.message, agent: t.agent, result },
    ...(t.threadRoot ? { thread_root_id: t.threadRoot } : {}),
  };
  if (t.threadRoot) useThreads.getState().received(made, t.conversation);
  else data.putMessages(t.conversation, [made]);
}
