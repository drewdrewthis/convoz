// Conversations: the list, one conversation (and a new one), and the page for one that does not exist.
import { registerHandler, registerResync } from "@convoz/api-client";
import { useConversations } from "./store.ts";

export { Conversation } from "./Conversation.tsx";
export { Conversations } from "./Conversations.tsx";
export { NotFound } from "./NotFound.tsx";

registerHandler("message.", (frame) => {
  if (frame.name === "message.created") useConversations.getState().received(frame.data.conversation_id, frame.data);
});
registerHandler("agent.", (frame) => {
  if (frame.name === "agent.working") useConversations.getState().setWorking(frame.data.conversation_id, frame.data.handle, Boolean(frame.data.working), frame.data.until);
});
registerResync(() => void useConversations.getState().drainOutbox());
