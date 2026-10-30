// Conversations: the list, one conversation (and a new one), and the page for one that does not exist.
import { debouncePer, registerHandler, registerResync, type MessageCreatedFrame } from "@convoz/api-client";
import { appPath, withBase } from "../../shared/base.ts";
import { data, sync } from "../../shared/data.ts";
import { arrivalToast } from "../now/index.ts";
import { toast } from "../pins-stars/index.ts";
import { batch, messageHref, messageLine } from "./messageToast.ts";
import "../../shared/presence.ts"; // takes the working and seen frames in
import { useConversations } from "./store.ts";

export { Conversations } from "./Conversations.tsx";
export { markAllRead, rename as renameConversation } from "./actions.ts";

// The list is a first screen, so this chunk holds only it; one conversation, its 404 and the trash are a chunk of their own
// (design §12.2). The route loads the page before the first render, as with any other page.
const pages = () => import("./pages.ts");
export const loadConversation = () => pages().then((p) => p.Conversation);
export const loadNotFound = () => pages().then((p) => p.NotFound);
export const loadTrash = () => pages().then((p) => p.Trash);

registerHandler("message.", (frame) => {
  if (frame.name !== "message.created") return;
  useConversations.getState().received(frame.data.conversation_id, frame.data);
  toastMessage(frame.data);
  // A line the conversation says about itself (someone was added, removed, renamed it) changed the details.
  const id = frame.data.conversation_id;
  if (frame.data.author.kind === "system" && data.store.getState().rows[id]) {
    reloadRow(id);
    // A removal closes the agent's asks; a plan line changes no ask (the plan frame brings the plan itself).
    if (frame.data.system?.t !== "plan.changed") refreshAsks(id);
  }
});
/** The messages of one second share one toast; its Open goes to the first, the one the toast names. */
const toastBatch = batch<{ line: string; href: string }>(1000, (news) => {
  const text = arrivalToast(news.map((n) => n.line));
  if (text) toast(text, () => location.assign(withBase(news[0]!.href)), "Open");
});
/** toastMessage queues the toast line of a new message from someone else, unless its conversation is open on screen or muted (messageLine). */
function toastMessage(m: MessageCreatedFrame): void {
  const { me, rows } = data.store.getState();
  if (!me) return;
  const open = /^\/chats\/(\d+)$/.exec(appPath());
  const row = rows[m.conversation_id];
  const muted = (row?.muted_until ?? 0) > Date.now();
  const line = messageLine(m, { me: me.identity.handle, open: open ? Number(open[1]) : null, title: row?.title, muted });
  if (line) toastBatch({ line, href: messageHref(m) });
}
/** A catch-up brings many system lines at once, and a slow one spreads them: the row and the asks are read once, after the burst. */
const BURST_MS = 200;
const reloadRow = debouncePer((id: number) => data.loadConversation(id).then(() => {}), BURST_MS);
const refreshAsks = debouncePer((id: number) => sync.refreshAsks(id), BURST_MS);
registerResync(() => void useConversations.getState().drainOutbox());

registerHandler("pin.", (frame) => {
  // Another device of the owner pinned or unpinned: the row that holds the pins is read again.
  if (frame.name === "pin.changed" && data.store.getState().rows[frame.data.conversation_id]) void data.loadConversation(frame.data.conversation_id).catch(() => {});
});

/** The replies of a thread drawn as a conversation draws them; a chunk of its own, since the transcript is large. */
export const loadFeedReplies = () => import("./FeedReplies.tsx").then((p) => p.FeedReplies);
export { planHash } from "./messages/PlanNote.tsx";
export { copyUrl } from "./messages/MessageMenu.tsx";
