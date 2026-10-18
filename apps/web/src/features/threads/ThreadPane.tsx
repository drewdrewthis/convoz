import { AttachIcon, BackIcon, SendIcon } from "@convoz/ui/icons";
import type { Message } from "@convoz/api-client";
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import { stripCf } from "../../shared/chat.ts";
import { AttachmentList, pasteFiles, useAttachments } from "../composer/index.ts";
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
  const picker = useRef<HTMLInputElement>(null);
  const attachments = useAttachments(t?.conversation ?? 0);
  const log = useRef<HTMLDivElement>(null);
  const root = t?.rootId;
  const total = (t?.replies.length ?? 0) + (t?.pending.length ?? 0);

  useEffect(() => {
    setText("");
    attachments.clear();
    input.current?.focus();
  }, [root]); // only when another thread opens

  // the newest reply is in view when one comes
  useEffect(() => {
    const el = log.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [total, root]);

  if (!t) return null;
  const heading = `in ${stripCf(title)}`;
  const files = attachments.items;
  const canSend = (text.trim() !== "" || files.length > 0) && files.every((f) => f.state === "done");
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!canSend) return;
    const sent = files.map((f) => f.upload!.id);
    setText("");
    attachments.clear();
    reply(text.trim(), sent);
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
        <AttachmentList attachments={attachments} />
        <div className="composer glass thrcomposer">
          <button type="button" className="attachbtn" aria-label="Attach a file to the reply" title="Attach a file" onClick={() => picker.current?.click()}>
            <AttachIcon />
          </button>
          <input
            ref={picker}
            type="file"
            multiple
            aria-label="Attach files to the reply"
            hidden
            onChange={(e) => {
              attachments.add(Array.from(e.target.files ?? []));
              e.target.value = ""; // the same file can be chosen again
            }}
          />
          <label htmlFor="thr-composer" className="sr">
            Reply in thread
          </label>
          <input ref={input} id="thr-composer" value={text} onChange={(e) => setText(e.target.value)} onPaste={(e) => pasteFiles(e, attachments)} placeholder="Reply…" autoComplete="off" enterKeyHint="send" />
          {text.trim() || files.length ? (
            <button type="submit" className="sendbtn" aria-label="Send reply" disabled={!canSend}>
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
