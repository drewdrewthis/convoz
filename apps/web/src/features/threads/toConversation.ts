import { call, client } from "../../shared/api.ts";
import { navigate } from "../../shared/navigate.ts";

/** Turns the thread of message `root` into a conversation of its own (owner only) and opens it. A refusal is shown by `call`. */
export async function turnIntoConversation(conversation: number, root: number): Promise<void> {
  const made = await call(client.POST("/api/conversations/{id}/threads/{root}/conversation", { params: { path: { id: conversation, root } } }));
  navigate(`/chats/${made.conversation.id}`);
}
