import { Button } from "@convoz/ui/Button";
import { useEffect, useId, useRef, useState, type ComponentType, type FormEvent } from "react";
import type { Message } from "@convoz/api-client";
import { loadFeedReplies } from "../conversations/index.ts";
import { useThreads } from "../threads/index.ts";
import { partsOf, takeRequest, type ThreadState } from "./replyView.ts";

type Replies = ComponentType<{
  conversation: number;
  root: number;
  replies: Message[];
}>;

interface FeedThreadProps {
  conversation: number;
  root: number;
  count?: number;
  /** Runs once the server took a reply typed in the card (`ok`), or lost it (!ok). The card changes here: the caller knows where it goes. */
  onReplied?: (ok: boolean) => void;
  /** A number that goes up each time the item asks for the thread to open with its reply box focused (the Reply button). It shows even with no replies yet. */
  request?: number;
  /** Sends the text another way (a server item: POST /api/feed/:id/reply, which also closes the item). Without it the text is a reply in the thread. */
  send?: (text: string) => void;
  /** What the reply box starts with: a draft ask's text, to edit before it is sent. */
  initial?: string;
}

/**
 * FeedThread is the thread of a feed card folded under it (owner, conv 179 msg 7988: "Show expandable thread in feed item directly").
 * It starts collapsed (owner, conv 179 msg 12313): a one-line summary when it has replies, nothing when it has none; the summary or the Reply button opens it. Opening it reads the replies through the threads store, as a conversation does, and
 * draws them in place with the conversation's own message rendering; folding it hides them again. The owner stays in Now.
 * "Reply here", under the open thread, answers in it without leaving Now (owner, conv 179 msg 8239): the reply shows in the thread as sending, then sent.
 */
export function FeedThread({ conversation, root, count: known, onReplied, request = 0, send: sendText, initial = "" }: FeedThreadProps) {
  const [view, setView] = useState<Pick<ThreadState, "seen" | "open" | "writing">>({ seen: 0, open: false, writing: false });
  const [text, setText] = useState(initial);
  const [Replies, setReplies] = useState<Replies | null>(null);
  const id = useId();
  const replies = useThreads((s) => s.threads[root]?.replies);
  const pending = useThreads((s) => s.threads[root]?.pending.length ?? 0);
  const count = Math.max(known ?? 0, replies?.length ?? 0) + pending;
  const taken = takeRequest({ count, request, ...view });
  // Reply was pressed: the thread opens with its box in this very render (no effect in between), and the box takes the focus as it mounts.
  if (taken.seen !== view.seen) setView({ seen: taken.seen, open: taken.open, writing: taken.writing });
  const { open, writing } = taken;
  const setOpen = (f: (o: boolean) => boolean) => setView((v) => ({ ...v, open: f(v.open) }));
  const setWriting = (w: boolean) => setView((v) => ({ ...v, writing: w }));
  useEffect(() => {
    void useThreads
      .getState()
      .load(conversation, root)
      .catch(() => {});
  }, [conversation, root]);
  useEffect(() => {
    if (!open) return;
    void loadFeedReplies().then((c) => setReplies(() => c));
  }, [open]);
  const input = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (request) input.current?.focus();
  }, [request, writing]);
  const parts = partsOf(taken);
  if (!parts.summary && !parts.box && !parts.replyHere) return null;

  const send = (e: FormEvent) => {
    e.preventDefault();
    const body = text.trim();
    if (!body) return;
    setText("");
    setWriting(false);
    setOpen(() => true);
    if (sendText) return sendText(body);
    const { load, reply } = useThreads.getState();
    void load(conversation, root).catch(() => {});
    void reply(root, body).then((ok) => onReplied?.(ok));
  };

  return (
    <div className="flex flex-col gap-4">
      {parts.summary ? (
        <Button variant="text" size="inline" className="-ml-8 self-start" aria-expanded={open} aria-controls={id} onClick={() => setOpen((o) => !o)}>
          {`${open ? "Hide" : "Show"} thread · ${count} ${count === 1 ? "reply" : "replies"}`}
        </Button>
      ) : null}
      {parts.replies ? (
        <div id={id} className="ithread !max-w-none !px-0" role="group" aria-label="Thread">
          <div className="ithbody">{Replies && replies ? <Replies conversation={conversation} root={root} replies={replies} /> : null}</div>
        </div>
      ) : null}
      {parts.box ? (
        <form className="flex items-center gap-8" onSubmit={send}>
          {/* eslint-disable-next-line convoz/no-raw-input -- a pill with no visible label (aria-label); Field draws a label above its input */}
          <input
            ref={input}
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
      ) : parts.replyHere ? (
        <Button variant="text" size="inline" className="-ml-8 self-start" onClick={() => setWriting(true)}>
          Reply here
        </Button>
      ) : null}
    </div>
  );
}
