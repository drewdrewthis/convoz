import type { Ask } from "@convoz/api-client";
import { Button } from "@convoz/ui/Button";
import { useEffect, useId, useState } from "react";
import { stripCf } from "../../shared/chat.ts";
import { useThreads } from "../threads/index.ts";

/**
 * FeedThread is the thread of an ask folded under its card in the feed (owner, conv 179 msg 7988: "Show expandable thread in feed item
 * directly"). It draws nothing for an ask with no replies. Opening it reads the replies through the threads store, as a conversation does,
 * and shows them in place; folding it hides them again. The owner stays in Now.
 */
export function FeedThread({ ask }: { ask: Ask }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const root = ask.thread_root_id ?? ask.id;
  const replies = useThreads((s) => s.threads[root]?.replies);
  const count = Math.max(ask.reply_count ?? 0, replies?.length ?? 0);
  useEffect(() => {
    if (open) void useThreads.getState().load(ask.conversation_id, root).catch(() => {});
  }, [open, ask.conversation_id, root]);
  if (!count) return null;
  return (
    <div className="flex flex-col gap-4">
      <Button variant="text" size="inline" className="-ml-8 self-start" aria-expanded={open} aria-controls={id} onClick={() => setOpen((o) => !o)}>
        {`${open ? "Hide" : "Show"} thread · ${count} ${count === 1 ? "reply" : "replies"}`}
      </Button>
      {open ? (
        <ul id={id} className="m-0 flex list-none flex-col gap-8 border-0 border-l-2 border-solid border-border p-0 pl-12" aria-label="Thread">
          {(replies ?? []).map((m) => (
            <li key={m.id} className="text-13 leading-[20px]">
              <b className="font-semibold">{m.author.handle}</b> <span className="text-muted [overflow-wrap:anywhere]">{stripCf(m.body)}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
