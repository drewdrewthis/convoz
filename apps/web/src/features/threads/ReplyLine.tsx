import type { Message } from "@convoz/api-client";
import { useThreads } from "./store.ts";

/** shortAgo is the age of the last reply as the prototype writes it: "now", "5m", "3h", "2d". */
export function shortAgo(at: number | undefined, now = Date.now()): string {
  const min = at ? Math.max(0, (now - at) / 60_000) : 0;
  if (min < 1) return "now";
  if (min < 60) return `${Math.round(min)}m`;
  if (min < 1440) return `${Math.round(min / 60)}h`;
  return `${Math.round(min / 1440)}d`;
}

/** The words under a thread root: "5 replies · last reply 5m" (the prototype's reply line). */
export const replyWords = (root: Pick<Message, "reply_count" | "last_reply_at">): string => {
  const n = root.reply_count ?? 0;
  return `${n} ${n === 1 ? "reply" : "replies"} · last reply ${shortAgo(root.last_reply_at)}`;
};

/** ReplyLine is the button under a thread root in the main list that opens its thread. It shows nothing for a message with no replies. */
export function ReplyLine({ message, conversation }: { message: Message; conversation: number }) {
  if (!message.reply_count) return null;
  const words = replyWords(message);
  return (
    <button type="button" className="replyline" aria-label={`Open thread, ${words}`} onClick={() => void useThreads.getState().openThread(conversation, message.id, message)}>
      <span>{words}</span>
    </button>
  );
}
