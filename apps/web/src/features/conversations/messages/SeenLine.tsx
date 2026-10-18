import type { Message } from "@convoz/api-client";
import { seenNote, useSeenBy } from "../../../shared/presence.ts";

/** "Seen by @agent" under the owner's message that agents have seen, in the main list or (threaded) in its thread. */
export function SeenLine({ conversation, message, threaded }: { conversation: number; message: Message; threaded?: boolean }) {
  const root = threaded ? (message.thread_root_id ?? message.id) : 0;
  const by = useSeenBy(conversation, root, message.id);
  const note = seenNote(by);
  return note ? (
    <div className="seen" title={by.length > 2 ? by.map((h) => `@${h}`).join(", ") : undefined}>
      {note}
    </div>
  ) : null;
}
