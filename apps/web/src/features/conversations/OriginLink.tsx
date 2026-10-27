import { Button } from "@convoz/ui/Button";
import type { Conversation } from "@convoz/api-client";
import { stripCf } from "../../shared/chat.ts";
import { visit } from "../../shared/navigate.ts";

/** The line under the title of a conversation made from a thread: where it came from, with a link back to the message. */
export function OriginLink({ origin }: { origin: NonNullable<Conversation["origin"]> }) {
  const title = stripCf(origin.conversation_title ?? "");
  const to = `/chats/${origin.conversation_id}#m${origin.message_id}`;
  return (
    <Button variant="quiet" size="inline" className="originlink" href={to} onClick={(event) => visit(event, to)}>
      {title ? `Started from a thread in ${title}` : "Started from a thread"}
    </Button>
  );
}
