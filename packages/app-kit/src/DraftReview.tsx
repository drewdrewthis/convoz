import { useLayoutEffect, useRef, useState } from "react";

/* The review of a draft ask: the message that is answered, the draft in a box the owner edits, and Send or Don't send.
 * Send carries the text as it stands, so the agent posts exactly what the owner approved. */

export interface DraftData {
  text: string;
  original?: string;
  original_from?: string;
}

/** The longest original the card shows; a longer one is cut and ends with "…". The server holds at most this many characters. */
const SHOWN_ORIGINAL = 2000;
const MAX_DRAFT = 4000;

const shown = (s: string): string => (s.length > SHOWN_ORIGINAL ? `${s.slice(0, SHOWN_ORIGINAL - 1)}…` : s);

/** DraftReview draws the original, the editable draft and the two buttons. It keeps only the text being edited. */
export function DraftReview({ draft, busy, onSend, onDecline }: { draft: DraftData; busy?: boolean; onSend(text: string): void; onDecline(): void }) {
  const [text, setText] = useState(draft.text);
  const box = useRef<HTMLTextAreaElement | null>(null);
  const edited = text !== draft.text;

  // The box grows with its text, so the owner reads the whole draft without scrolling inside it.
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [text]);

  return (
    <div className="askdraft">
      {draft.original ? (
        <blockquote className="askorig">
          {draft.original_from ? <p className="askorigfrom">{draft.original_from}</p> : null}
          <p className="askorigtext">{shown(draft.original)}</p>
        </blockquote>
      ) : null}
      <div className="askdraftlabel">
        <span>Draft</span>
        {edited ? <span className="askedited">Edited</span> : null}
      </div>
      {/* 16px text keeps a phone from zooming in on focus; the box scrolls into view above the keyboard. */}
      <textarea
        ref={box}
        className="askdrafttext"
        aria-label="Draft"
        value={text}
        maxLength={MAX_DRAFT}
        rows={3}
        onChange={(e) => setText(e.target.value)}
        onFocus={(e) => {
          const el = e.currentTarget;
          setTimeout(() => el.scrollIntoView?.({ block: "center", behavior: "smooth" }), 300);
        }}
      />
      <div className="askopts">
        <button className="askopt rec" type="button" disabled={busy || !text.trim()} onClick={() => onSend(text.trim())}>
          Send
        </button>
        <button className="askopt" type="button" disabled={busy} onClick={onDecline}>
          Don't send
        </button>
      </div>
    </div>
  );
}
