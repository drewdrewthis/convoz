import type { Message } from "@convoz/api-client";
import { stripCf } from "../../../shared/chat.ts";
import { PlanNote } from "./PlanNote.tsx";

/** NoticeRow is a system line: an icon and muted words, no author and no way to reply (I-8). */
export function NoticeRow({ message, conversation }: { message: Message; conversation: number }) {
  if (message.system?.t === "plan.changed") return <PlanNote message={message} conversation={conversation} />;
  return (
    <div className="notice-line" role="note" data-t={message.system?.t}>
      <span className="notice-text">{stripCf(message.text ?? message.body)}</span>
    </div>
  );
}
