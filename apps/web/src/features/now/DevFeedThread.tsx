import { Button } from "@convoz/ui/Button";
import { useEffect, useId, useState, type ComponentType, type FormEvent } from "react";
import type { Message } from "@convoz/api-client";
import { loadFeedReplies } from "../conversations/index.ts";
import { useThreads } from "../threads/index.ts";

type Replies = ComponentType<{ conversation: number; root: number; replies: Message[] }>;

interface FeedThreadProps {
  conversation: number;
  root: number;
  count?: number;
  /** Runs once the server took a reply typed in the card (`ok`), or lost it (!ok). The card changes here: the caller knows where it goes. */
  onReplied?: (ok: boolean) => void;
  /** A number that goes up each time the item asks for the thread to open with its reply box focused ("Add info"). It shows even with no replies yet. */
  request?: number;
}

/**
 * FeedThread is the thread of a feed card folded under it (owner, conv 179 msg 7988: "Show expandable thread in feed item directly").
 * It draws nothing for a thread with no replies. Opening it reads the replies through the threads store, as a conversation does, and
 * draws them in place with the conversation's own message rendering; folding it hides them again. The owner stays in Now.
 * "Reply here", under the open thread, answers in it without leaving Now (owner, conv 179 msg 8239): the reply shows in the thread as sending, then sent.
 */
export function FeedThread({ conversation, root, count: known, onReplied, request = 0 }: FeedThreadProps) {
  const [open, setOpen] = useState(false);
  const [writing, setWriting] = useState(false);
  const [text, setText] = useState("");
  const [Replies, setReplies] = useState<Replies | null>(null);
  const id = useId();
  const replies = useThreads((s) => s.threads[root]?.replies);
  const pending = useThreads((s) => s.threads[root]?.pending.length ?? 0);
  const count = Math.max(known ?? 0, replies?.length ?? 0) + pending;
  useEffect(() => {
    if (!open) return;
    void useThreads.getState().load(conversation, root).catch(() => {});
    void loadFeedReplies().then((c) => setReplies(() => c));
  }, [open, conversation, root]);
  useEffect(() => {
    if (!request) return;
    setOpen(true);
    setWriting(true);
  }, [request]);
  if (!count && !request) return null;

  const send = (e: FormEvent) => {
    e.preventDefault();
    const body = text.trim();
    if (!body) return;
    setText("");
    setWriting(false);
    setOpen(true);
    const { load, reply } = useThreads.getState();
    void load(conversation, root).catch(() => {});
    void reply(root, body).then((ok) => onReplied?.(ok));
  };

  return (
    <div className="flex flex-col gap-4">
      <Button variant="text" size="inline" className="-ml-8 self-start" aria-expanded={open} aria-controls={id} onClick={() => setOpen((o) => !o)}>
        {`${open ? "Hide" : "Show"} thread · ${count} ${count === 1 ? "reply" : "replies"}`}
      </Button>
      {open ? (
        <div id={id} className="ithread !max-w-none !px-0" role="group" aria-label="Thread">
          <div className="ithbody">{Replies && replies ? <Replies conversation={conversation} root={root} replies={replies} /> : null}</div>
        </div>
      ) : null}
      {!open ? null : writing ? (
        <form className="flex items-center gap-8" onSubmit={send}>
          {/* eslint-disable-next-line convoz/no-raw-input -- a pill with no visible label (aria-label); Field draws a label above its input */}
          <input
            aria-label="Reply to the thread"
            type="text"
            autoFocus
            value={text}
            maxLength={4000}
            onChange={(e) => setText(e.target.value)}
            className="h-52 w-full min-w-0 flex-auto rounded-full border border-solid border-edge bg-raised px-16 text-16 text-text [font-family:inherit]"
          />
          <Button variant="primary" size="inline" type="submit" aria-label="Send reply" disabled={!text.trim()}>
            Send
          </Button>
        </form>
      ) : (
        <Button variant="text" size="inline" className="-ml-8 self-start" onClick={() => setWriting(true)}>
          Reply here
        </Button>
      )}
    </div>
  );
}
