// Threads: replies under a message, the thread pane and its read state.
// Owned by the threads work package. It draws inside a conversation, not at a URL of its own.
import { registerHandler, registerResync } from "@convoz/api-client";
import { useThreads } from "./store.ts";

export { ReplyLine, replyWords, useNewReplies } from "./ReplyLine.tsx";
export { ThreadFold, ThreadRows } from "./ThreadRows.tsx";
export { ThreadPane, type ThreadPaneProps } from "./ThreadPane.tsx";
export { useThreads, type PendingReply } from "./store.ts";

// A reply of the open thread comes by the stream: taken in, changed or shown as deleted.
registerHandler("message.", (frame) => {
  if (frame.name === "message.created" || frame.name === "message.edited" || frame.name === "message.deleted" || frame.name === "message.purged") {
    useThreads.getState().received(frame.data, frame.data.conversation_id);
  }
});
registerResync(() => void useThreads.getState().refresh());

// A voice reply gets its words later: the frame carries the message as it is now, so the open thread takes it in like an edit.
registerHandler("upload.transcribed", (frame) => {
  if (frame.name === "upload.transcribed") useThreads.getState().received(frame.data, frame.data.conversation_id);
});
