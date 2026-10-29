import { Button } from "@convoz/ui/Button";
import { useEffect, useRef, useState, type FormEvent } from "react";

/** ReplyBox is the empty reply box of a feed item that has no thread yet: the first text starts the thread (POST /api/feed/:id/reply). A request that goes up puts the focus in the box (the Reply button). */
export function ReplyBox({ send, busy, request = 0 }: { send: (text: string) => void; busy: boolean; request?: number }) {
  const [text, setText] = useState("");
  const input = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (request) input.current?.focus();
  }, [request]);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!text.trim()) return;
    send(text.trim());
    setText("");
  };
  return (
    <form className="flex items-center gap-8" onSubmit={submit}>
      {/* eslint-disable-next-line convoz/no-raw-input -- a pill with no visible label (aria-label); Field draws a label above its input */}
      <input ref={input} aria-label="Reply to the thread" type="text" value={text} maxLength={4000} onChange={(e) => setText(e.target.value)} className="h-52 w-full min-w-0 flex-auto rounded-full border border-solid border-edge bg-raised px-16 text-16 text-text [font-family:inherit]" />
      <Button variant="primary" size="inline" type="submit" aria-label="Send reply" disabled={busy || !text.trim()}>
        Send
      </Button>
    </form>
  );
}
