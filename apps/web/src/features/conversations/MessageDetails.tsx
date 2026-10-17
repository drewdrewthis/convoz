import type { Message } from "@convoz/api-client";
import { Sheet } from "@convoz/ui/Sheet";
import { useEffect, useState } from "react";
import { fmtDate } from "../../shared/api.ts";
import { source } from "../../shared/data.ts";
import { CancelButton } from "../../shared/sheets.tsx";

/**
 * MessageDetails is the sheet "Message details": who wrote the message and where it ran. The page may hold the message from a
 * live frame, which does not say where it ran, so the sheet asks the server for that one message.
 */
export function MessageDetails({ conversationId, message, done }: { conversationId: number; message: Message; done(): void }) {
  const [full, setFull] = useState<Message>(message);
  useEffect(() => {
    let live = true;
    source
      .messages(conversationId, { after: message.id - 1, limit: 1 })
      .then(({ messages }) => live && messages[0]?.id === message.id && setFull(messages[0]))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [conversationId, message]);
  const who = full.author.kind === "agent" ? `@${full.author.handle}` : full.author.display_name || full.author.handle;
  return (
    <Sheet title="Message details" onClose={done} actions={<CancelButton onClick={done} />}>
      <dl className="convrows">
        <div className="convrow">
          <dt>From</dt>
          <dd>{who}</dd>
        </div>
        {full.via ? (
          <>
            <div className="convrow">
              <dt>Session</dt>
              <dd>{full.via.session}</dd>
            </div>
            <div className="convrow">
              <dt>Machine</dt>
              <dd>{full.via.machine}</dd>
            </div>
          </>
        ) : null}
        <div className="convrow">
          <dt>Sent</dt>
          <dd>{fmtDate(full.created_at)}</dd>
        </div>
      </dl>
    </Sheet>
  );
}
