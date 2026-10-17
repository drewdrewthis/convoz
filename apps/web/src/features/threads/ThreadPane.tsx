import { BackIcon, SendIcon } from "@convoz/ui/icons";
import type { Message } from "@convoz/api-client";
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import { stripCf } from "../../shared/chat.ts";
import { useThreads, type PendingReply } from "./store.ts";

/** A thread sits beside the chat from this width, and fills the screen below it. */
const WIDE = "(min-width: 900px)";

function useWide(): boolean {
  const [wide, setWide] = useState(() => matchMedia(WIDE).matches);
  useEffect(() => {
    const list = matchMedia(WIDE);
    const on = () => setWide(list.matches);
    list.addEventListener("change", on);
    return () => list.removeEventListener("change", on);
  }, []);
  return wide;
}

const CloseIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
    <path d="M18 6L6 18M6 6l12 12" />
  </svg>
);

export interface ThreadPaneProps {
  /** The conversation's title, for "in <title>". */
  title: string;
  /** The messages of the thread drawn the way the main list draws them (the conversation page owns that look). */
  bubbles(list: Message[], pending: PendingReply[]): ReactNode;
}

/**
 * ThreadPane is the open thread (prototype v41): the root and its replies, a "Reply…" box and "Also send to conversation".
 * Beside the chat on a wide screen, a full-screen sheet with Back on a phone. It draws nothing when no thread is open.
 */
export function ThreadPane({ title, bubbles }: ThreadPaneProps) {
  const t = useThreads((s) => s.open);
  const { close, setAlso, reply } = useThreads.getState();
  const wide = useWide();
  const [text, setText] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const log = useRef<HTMLDivElement>(null);
  const root = t?.rootId;
  const total = (t?.replies.length ?? 0) + (t?.pending.length ?? 0);

  useEffect(() => {
    setText("");
    input.current?.focus();
  }, [root]);

  // the newest reply is in view when one comes
  useEffect(() => {
    const el = log.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [total, root]);

  if (!t) return null;
  const heading = `in ${stripCf(title)}`;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const body = text.trim();
    if (!body) return;
    setText("");
    reply(body);
  };
  const key = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      close();
    }
  };
  const count = t.loaded ? (total ? `${total} ${total === 1 ? "reply" : "replies"}` : "No replies yet") : "";
  const parts = (
    <>
      <header className="threadbar">
        {wide ? null : (
          <button type="button" className="iconbtn" aria-label="Back" onClick={close}>
            <BackIcon />
          </button>
        )}
        <div className="titles">
          <h2>Thread</h2>
          <span className="sub">{heading}</span>
        </div>
        {wide ? (
          <button type="button" className="iconbtn thrclose" aria-label="Close thread" onClick={close}>
            <CloseIcon />
          </button>
        ) : null}
      </header>
      <div ref={log} className="threadlog" role="log" aria-label="Thread messages">
        {t.root ? bubbles([t.root], []) : null}
        <div className="threadcount">
          <span>{count}</span>
          <span className="rule" aria-hidden="true" />
        </div>
        {bubbles(t.replies, t.pending)}
      </div>
      <form className="threadform" onSubmit={submit}>
        <div className="composer glass thrcomposer">
          <label htmlFor="thr-composer" className="sr">
            Reply in thread
          </label>
          <input ref={input} id="thr-composer" value={text} onChange={(e) => setText(e.target.value)} placeholder="Reply…" autoComplete="off" enterKeyHint="send" />
          {text.trim() ? (
            <button type="submit" className="sendbtn" aria-label="Send reply">
              <SendIcon />
            </button>
          ) : null}
        </div>
        <label className="alsorow">
          <input type="checkbox" checked={t.also} onChange={(e) => setAlso(e.target.checked)} />
          Also send to conversation
        </label>
      </form>
    </>
  );
  return wide ? (
    <aside className="thread" aria-label={`Thread ${heading}`} onKeyDown={key}>
      {parts}
    </aside>
  ) : (
    <div className="thread sheet" role="dialog" aria-modal="true" aria-label={`Thread ${heading}`} onKeyDown={key}>
      {parts}
    </div>
  );
}
