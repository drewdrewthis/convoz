import type { Message } from "@convoz/api-client";
import { stripCf } from "../../../shared/chat.ts";
import { PlanNote } from "./PlanNote.tsx";
import { Uploads } from "./Uploads.tsx";
import { Button } from "@convoz/ui/Button";

/**
 * NoticeRow is a system line: an icon and muted words, no author and no way to reply (I-8). A screenshot an agent took of the shared
 * tab (page.shot) shows under its line, so the owner sees what the agent saw.
 */
export function NoticeRow({ message, conversation, canResume, onResume }: { message: Message; conversation: number; canResume: boolean; onResume(): void }) {
  if (message.system?.t === "plan.changed") return <PlanNote message={message} conversation={conversation} />;
  return (
    <div className="notice-line" role="note" data-t={message.system?.t}>
      <span className="notice-text">{stripCf(message.text ?? message.body)}</span>
      {message.uploads?.length ? (
        <div className="notice-files">
          <Uploads uploads={message.uploads} body="" />
        </div>
      ) : null}
      {canResume ? (
        <Button size="small" onClick={onResume}>
          Resume
        </Button>
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
