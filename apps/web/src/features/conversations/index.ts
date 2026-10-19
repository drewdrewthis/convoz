// Conversations: the list, one conversation (and a new one), and the page for one that does not exist.
import { registerHandler, registerResync } from "@convoz/api-client";
import { data, source } from "../../shared/data.ts";
import "../../shared/presence.ts"; // takes the working and seen frames in
import { useConversations } from "./store.ts";

export { Conversations } from "./Conversations.tsx";
export { markAllRead } from "./actions.ts";

// The list is a first screen, so this chunk holds only it; one conversation, its 404 and the trash are a chunk of their own
// (design §12.2). The route loads the page before the first render, as with any other page.
const pages = () => import("./pages.ts");
export const loadConversation = () => pages().then((p) => p.Conversation);
export const loadNotFound = () => pages().then((p) => p.NotFound);
export const loadTrash = () => pages().then((p) => p.Trash);

registerHandler("message.", (frame) => {
  if (frame.name !== "message.created") return;
  useConversations.getState().received(frame.data.conversation_id, frame.data);
  // A line the conversation says about itself (someone was added, removed, the agents paused) changed the details.
  const id = frame.data.conversation_id;
  if (frame.data.author.kind === "system" && data.store.getState().rows[id]) {
    void data.loadConversation(id).catch(() => {});
    void refreshAsks(id).catch(() => {}); // a removal closes the agent's asks
  }
});
registerResync(() => void useConversations.getState().drainOutbox());

/** refreshAsks takes the newest state of the asks the page holds: a change of an ask is not a new message, so no frame brings it. */
async function refreshAsks(convId: number): Promise<void> {
  const held = data.store.getState().messages[convId];
  if (!held?.list.some((m) => m.kind === "ask")) return;
  const { messages } = await source.messages(convId, { limit: 100 });
  const fresh = new Map(messages.filter((m) => m.kind === "ask").map((m) => [m.id, m]));
  data.store.setState((s) => {
    const now = s.messages[convId];
    if (!now) return s;
    return { messages: { ...s.messages, [convId]: { ...now, list: now.list.map((m) => (m.kind === "ask" && fresh.has(m.id) ? fresh.get(m.id)! : m)) } } };
  });
}
registerHandler("pin.", (frame) => {
  // Another device of the owner pinned or unpinned: the row that holds the pins is read again.
  if (frame.name === "pin.changed" && data.store.getState().rows[frame.data.conversation_id]) void data.loadConversation(frame.data.conversation_id).catch(() => {});
});
