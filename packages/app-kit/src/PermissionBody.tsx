import { useState, type ReactNode } from "react";
import { Button } from "@convoz/ui/Button";
import { cx } from "@convoz/ui/cx";
import { ReplyCount } from "./ReplyCount.tsx";
import type { AskData, AskPermission } from "./askData.ts";

/** A fold's chevron: it turns down when open. Hidden from the accessible name, which stays the fold's text. */
const Chevron = ({ open }: { open: boolean }) => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={cx("ml-4 flex-none text-accent-text transition-transform", open && "rotate-90")}>
    <path d="M9 6l6 6-6 6" />
  </svg>
);

/* The body of a permission ask: one action the agent is sure of, what it risks, how to undo it and the ways it turned down. The owner says Go or Not this. */

const ONE_WAY = "None. This is one-way.";
const GO_KEY = "Enter G";

/** Fields lists Risk, Undo and Considered; one-way is said in words and in the danger colour, never by colour alone. */
function Fields({ p, phone, fold }: { p: AskPermission; phone: boolean; fold: boolean }) {
  const [more, setMore] = useState(false);
  const folded = phone && fold && !more;
  const n = p.considered.length;
  return (
    <>
      <dt className="mt-6 font-semibold text-text">Risk</dt>
      <dd className="m-0 text-text [overflow-wrap:anywhere]">{p.risk}</dd>
      <dt className="mt-6 font-semibold text-text">Undo</dt>
      <dd className={cx("m-0 [overflow-wrap:anywhere]", p.one_way ? "font-semibold text-danger" : "text-text")}>{p.one_way ? ONE_WAY : p.undo}</dd>
      {folded ? (
        <dd className="m-0 mt-6">
          <Button variant="muted" size="inline" className="-ml-8" aria-expanded={false} onClick={() => setMore(true)}>
            {`Considered ${n} other ${n === 1 ? "way" : "ways"}`}
            <Chevron open={false} />
          </Button>
        </dd>
      ) : (
        <>
          <dt className="mt-6 font-semibold text-text">Considered, and why worse</dt>
          {p.considered.map((c, i) => (
            <dd key={i} className="m-0 [overflow-wrap:anywhere]">
              {c}
            </dd>
          ))}
        </>
      )}
    </>
  );
}

export interface PermissionBodyProps {
  ask: AskData;
  permission: AskPermission;
  /** The id of the action's text; the card is named by it. */
  labelId: string;
  where: "now" | "conversation";
  /** The byline of Now: who asked, in which conversation, when. */
  meta: string;
  urgent: boolean;
  open: boolean;
  phone: boolean;
  busy?: boolean;
  /** The "Not this" box is open. */
  notThis: boolean;
  text: string;
  setText(v: string): void;
  onGo(): void;
  onNotThis(): void;
  onSend(): void;
  /** "I have questions"; none where the Reply box is already beside the card. */
  onReply?(): void;
  replies?: { count?: number; unread?: number };
  /** The pill of a closed ask that is not a Go or a Not this (dismissed, closed). */
  stateLine: string;
  /** The action row (Snooze, Open, Dismiss), drawn under the buttons of an open card. */
  actions: ReactNode;
  /** The feed's thread: drawn above the buttons, so everything that answers is last. */
  footer?: ReactNode;
  clear?: string | false;
}

/** PermissionBody draws the permission ask: open (byline, fields, Go and Not this) or answered (a pill and Details). */
export function PermissionBody({ ask, permission: p, labelId, where, meta, urgent, open, phone, busy, notThis, text, setText, onGo, onNotThis, onSend, onReply, replies, stateLine, actions, footer, clear }: PermissionBodyProps) {
  const [details, setDetails] = useState(false);
  const handle = ask.asker.handle;
  if (!open) {
    const said = ask.answer === "Go" ? "You said Go" : ask.answer?.startsWith("Not this: ") ? `Not this · ${ask.answer.slice("Not this: ".length)}` : stateLine;
    return (
      <>
        <h3 id={labelId} className="m-0 pt-12 pb-3 text-17 leading-[22px] font-semibold text-text [overflow-wrap:anywhere]">
          {p.action}
        </h3>
        <p className="m-0 mt-4 w-fit rounded-full bg-soft px-10 py-px text-14 font-semibold text-accent-text [overflow-wrap:anywhere]">{said}</p>
        <Button variant="text" size="inline" className="-ml-8 mt-4" aria-expanded={details} onClick={() => setDetails((d) => !d)}>
          Details
          <Chevron open={details} />
        </Button>
        {details ? (
          <dl className="m-0 mb-8 text-13 leading-[18px] text-muted">
            <Fields p={p} phone={phone} fold={false} />
          </dl>
        ) : null}
      </>
    );
  }
  return (
    <>
      {where === "now" ? (
        <div className={cx("flex items-center gap-x-8 pt-12 text-13 leading-[20px] text-muted", clear)}>
          <span className="min-w-0 truncate" title={meta}>
            {meta}
          </span>
          {urgent ? <span className="ml-auto flex-none font-semibold text-danger">Urgent</span> : null}
        </div>
      ) : null}
      <dl className={cx("m-0 mb-12 text-13 leading-[18px] text-muted", where === "conversation" ? "pt-12" : "pt-6")}>
        <dt className="font-semibold text-text">I will</dt>
        <dd id={labelId} className="m-0 text-17 leading-[22px] font-semibold text-text [overflow-wrap:anywhere]">
          {p.action}
        </dd>
        <Fields p={p} phone={phone} fold />
      </dl>
      {footer}
      <div className={cx("flex gap-8", phone ? "flex-col" : "flex-row [&>*]:flex-1")}>
        <Button size="option" variant="primary" disabled={busy} aria-keyshortcuts={p.one_way ? "G" : GO_KEY} onClick={onGo}>
          Go
        </Button>
        <Button size="option" aria-expanded={notThis} aria-keyshortcuts="N R" disabled={busy} onClick={onNotThis}>
          Not this
        </Button>
      </div>
      {notThis ? (
        <form
          className="mt-8 flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            onSend();
          }}
        >
          <label htmlFor={`${labelId}-why`} className="text-13 font-semibold text-text">{`Why not? @${handle} reads this.`}</label>
          <div className="flex items-center gap-8">
            {/* eslint-disable-next-line convoz/no-raw-input -- a pill like the quick reply; Field draws a label above a box, this label sits above the pill and the Send button */}
            <input
              id={`${labelId}-why`}
              type="text"
              autoFocus
              value={text}
              maxLength={4000}
              onChange={(e) => setText(e.target.value)}
              className="h-52 w-full min-w-0 flex-auto rounded-full border border-solid border-edge bg-raised px-16 text-16 text-text [font-family:inherit]"
            />
            <Button variant="primary" size="inline" type="submit" disabled={busy || !text.trim()}>
              Send
            </Button>
          </div>
        </form>
      ) : null}
      {onReply ? (
        <Button size="option" variant="dashed" className="mt-8" onClick={onReply}>
          I have questions
          <ReplyCount count={replies?.count} unread={replies?.unread} />
        </Button>
      ) : null}
      {actions}
    </>
  );
}
