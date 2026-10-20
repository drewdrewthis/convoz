import { useCallback, useEffect } from "react";
import { data, useLive } from "../../shared/data.ts";
import { replyingNote, seenNote, usePresence, useReplying, useSeenBy } from "../../shared/presence.ts";

/** What the agents of a conversation are doing about the owner's last message: "Seen by @a" and "@a is replying…". Nothing when neither. */
export function Attention({ conversation }: { conversation: number }) {
  // The stored "seen" comes with the conversation row; the live frames keep it up to date. A phone has no rail to hold the
  // stream open, so the card does.
  const load = useCallback(() => void data.loadConversation(conversation).then((row) => usePresence.getState().hydrate(conversation, 0, row.seen), () => {}), [conversation]);
  useEffect(load, [load]);
  useLive(load);
  const seen = seenNote(useSeenBy(conversation, 0));
  const replying = replyingNote(useReplying(conversation));
  if (!seen && !replying) return null;
  return (
    <div className="-mt-2 mx-4 flex flex-wrap items-center gap-x-14 gap-y-4">
      {seen ? <span className="text-12 text-muted">{seen}</span> : null}
      {replying ? (
        // `working` is the replying line of the transcript (with its pulsing dot); here it sits flush in the row.
        <span className="working m-0 text-12 text-muted" role="status">
          {replying}
        </span>
      ) : null}
    </div>
  );
}
