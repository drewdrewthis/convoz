import type { Message } from "@convoz/api-client";
import { stripCf } from "../../../shared/chat.ts";

/** NoticeRow is a system line: an icon and muted words, no author and no way to reply (I-8). */
export function NoticeRow({ message, canResume, onResume }: { message: Message; canResume: boolean; onResume(): void }) {
  return (
    <div className="notice-line" role="note" data-t={message.system?.t}>
      <span className="notice-text">{stripCf(message.text ?? "")}</span>
      {canResume ? (
        <button className="btn small" type="button" onClick={onResume}>
          Resume
        </button>
      ) : null}
    </div>
  );
}

/** pausedNow says whether the newest loop line of the log is a pause (the log holds a resume line after a resume). */
export function pausedNow(messages: Message[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const t = messages[i]!.system?.t;
    if (t === "conversation.resumed") return 0;
    if (t === "conversation.paused") return messages[i]!.id;
  }
  return 0;
}
