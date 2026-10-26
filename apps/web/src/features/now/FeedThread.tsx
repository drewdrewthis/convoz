import { Button } from "@convoz/ui/Button";
import { useEffect, useId, useState, type ComponentType } from "react";
import type { Message } from "@convoz/api-client";
import { loadFeedReplies } from "../conversations/index.ts";
import { useThreads } from "../threads/index.ts";

type Replies = ComponentType<{ conversation: number; replies: Message[] }>;

/**
 * FeedThread is the thread of a feed card folded under it (owner, conv 179 msg 7988: "Show expandable thread in feed item directly").
 * It draws nothing for a thread with no replies. Opening it reads the replies through the threads store, as a conversation does, and
 * draws them in place with the conversation's own message rendering; folding it hides them again. The owner stays in Now.
 */
export function FeedThread({ conversation, root, count: known }: { conversation: number; root: number; count?: number }) {
  const [open, setOpen] = useState(false);
  const [Replies, setReplies] = useState<Replies | null>(null);
  const id = useId();
  const replies = useThreads((s) => s.threads[root]?.replies);
  const count = Math.max(known ?? 0, replies?.length ?? 0);
  useEffect(() => {
    if (!open) return;
    void useThreads.getState().load(conversation, root).catch(() => {});
    void loadFeedReplies().then((c) => setReplies(() => c));
  }, [open, conversation, root]);
  if (!count) return null;
  return (
    <div className="flex flex-col gap-4">
      <Button variant="text" size="inline" className="-ml-8 self-start" aria-expanded={open} aria-controls={id} onClick={() => setOpen((o) => !o)}>
        {`${open ? "Hide" : "Show"} thread · ${count} ${count === 1 ? "reply" : "replies"}`}
      </Button>
      {open ? (
        <div id={id} className="ithread !max-w-none !px-0" role="group" aria-label="Thread">
          <div className="ithbody">{Replies && replies ? <Replies conversation={conversation} replies={replies} /> : null}</div>
        </div>
      ) : null}
    </div>
  );
}
