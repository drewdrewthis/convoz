// The Now call's reads and the home of its logs (engine.ts runs the call; tools.ts decides what may run).
import { call, client } from "../../shared/api.ts";
import { newId } from "../../shared/chat.ts";

/** The conversation that holds the logs of Now calls: found by its title, made the first time. The owner is its only member. */
export const CALLS_TITLE = "Calls with @voice";

/** The most characters of one ask's words that go to the model. */
const MOST_ASK = 500;

/** What waits for the owner, for the model: the open asks in the server's order (urgent first), and how many other things wait. */
export async function readNow(): Promise<Record<string, unknown>> {
  const now = await call(client.GET("/api/now"));
  return {
    asks: now.asks.map((a) => ({
      ask_id: a.id,
      question: a.question.slice(0, MOST_ASK),
      options: a.options.map((o) => o.label),
      from: a.asker.handle,
      conversation: a.conversation?.title ?? "",
      conversation_id: a.conversation_id,
      urgent: a.urgent,
    })),
    snoozed: now.snoozed.length,
    plans_waiting: now.waiting_plans.length,
    adds_waiting: now.pending_adds.length,
    machines_waiting: now.machine_requests.length,
  };
}

/**
 * The conversation of the Now calls' logs: the owner's one titled CALLS_TITLE, made with no agent in it the first time. It is found by
 * its title, so an owner who renames it gets a new one on the next call.
 */
export async function callsConversation(): Promise<number> {
  const { conversations } = await call(client.GET("/api/conversations"));
  const found = conversations.find((c) => c.title === CALLS_TITLE);
  if (found) return found.id;
  return (await call(client.POST("/api/conversations", { body: { client_id: newId(), title: CALLS_TITLE, participants: [] } }))).conversation.id;
}
