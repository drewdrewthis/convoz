import { useLayoutEffect, useRef, useState } from "react";
import { Button } from "@convoz/ui/Button";

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
    <div className="mt-6 flex flex-col gap-8">
      {draft.original ? (
        <blockquote className="m-0 max-h-[40vh] overflow-y-auto border-0 border-l-3 border-solid border-border px-12 py-6 text-14 leading-[20px] text-muted [overflow-wrap:anywhere]">
          {draft.original_from ? <p className="m-0 text-12 font-semibold text-text">{draft.original_from}</p> : null}
          <p className="m-0 whitespace-pre-wrap">{shown(draft.original)}</p>
        </blockquote>
      ) : null}
      <div className="flex items-center gap-8 text-12 font-bold tracking-[.04em] text-text uppercase">
        <span>Draft</span>
        {edited ? <span className="rounded-full bg-soft px-6 text-[11px] font-semibold tracking-[0] text-muted normal-case">Edited</span> : null}
      </div>
      {/* 16px text keeps a phone from zooming in on focus; the box scrolls into view above the keyboard. */}
      <textarea
        ref={box}
        className="box-border max-h-[60vh] min-h-88 w-full resize-none overflow-y-auto rounded-[12px] border border-solid border-border bg-surface px-12 py-10 text-16 leading-[22px] text-text [font-family:inherit] [scroll-margin-block:80px] focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-1"
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
      <div className="flex flex-col gap-8">
        <Button size="option" variant="primary" disabled={busy || !text.trim()} onClick={() => onSend(text.trim())}>
          Send
        </Button>
        <Button size="option" variant="dashed" disabled={busy} onClick={onDecline}>
          Don't send
        </Button>
      </div>
    </div>
  );
}
