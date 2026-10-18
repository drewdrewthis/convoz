import type { Message } from "@convoz/api-client";
import { useData } from "../../shared/data.ts";
import { useThreads } from "./store.ts";

/** The words on a reply chip: "2 replies · @claude-convoz" (the last replier; "you" when it is the viewer). */
export const replyWords = (root: Pick<Message, "reply_count" | "last_reply">, me: string | undefined): string => {
  const n = root.reply_count ?? 0;
  const count = `${n} ${n === 1 ? "reply" : "replies"}`;
  const by = root.last_reply?.author.handle;
  return by ? `${count} · ${by === me ? "you" : `@${by}`}` : count;
};

/**
 * ReplyLine is what a thread root shows in the main list (owner design B, 2026-10-18): a bold reply chip "↳ N replies · @handle" and
 * under it a faded peek "handle: preview" of the last reply. One tap on either opens the thread. The chip has a dot when the last
 * reply is past the viewer's read point. It shows nothing for a message with no replies.
 */
export function ReplyLine({ message, conversation }: { message: Message; conversation: number }) {
  const me = useData((s) => s.me?.identity.handle);
  const readThrough = useThreads((s) => s.readThrough[message.id] ?? 0);
  if (!message.reply_count) return null;
  const last = message.last_reply;
  const words = replyWords(message, me);
  const unread = !!last?.unread && last.id > readThrough;
  const open = () => void useThreads.getState().openThread(conversation, message.id, message);
  const who = last ? (last.author.handle === me ? "you" : last.author.handle) : "";
  return (
    <div className="replybox">
      <button type="button" className="replyline" aria-label={`Open thread, ${words}${unread ? ", unread" : ""}`} onClick={open}>
        <span>{words}</span>
        {unread ? <i className="replydot" aria-hidden="true" /> : null}
      </button>
      {last ? (
        <button type="button" className="replypeek" aria-label={`Last reply by ${who}: ${last.preview}`} onClick={open}>
          <span className="who">{who}:</span> <span className="said">{last.preview}</span>
        </button>
      ) : null}
    </div>
  );
}
