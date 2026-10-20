import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent, type ReactNode } from "react";
import { Button } from "@convoz/ui/Button";
import { cx } from "@convoz/ui/cx";
import { DraftReview } from "./DraftReview.tsx";
import { AskMenu, MenuItem } from "./AskMenu.tsx";
import { clock, historyText, stateLine, waitingLine, whoLine, type Answer, type AskData, type SnoozePreset } from "./askData.ts";

/* The ask card: one question an agent put to the owner, with the answers it offers. Now and a conversation draw the same card. */

export interface AskCardProps {
  ask: AskData;
  /** now: the card of the Now list (who asked, which conversation, quick reply). conversation: the card in the transcript (the same quick buttons; History is in the ⋯ menu). */
  where: "now" | "conversation";
  /** The id of the question's heading; the card is named by it. */
  labelId: string;
  /** article: the card is its own landmark and takes the keys. div: the caller's article names it. */
  as?: "article" | "div";
  presets: SnoozePreset[];
  busy?: boolean;
  /** The unused-answer line shown after a lost race. */
  notice?: string;
  onAnswer(answer: Answer): void;
  onDismiss(): void;
  onUndismiss(): void;
  onSnooze(preset: string): void;
  /** "Reply in thread": opens the thread on this ask. No button where the Reply box is already beside the card. */
  onReply?(): void;
  /** Pin and Delete of the message that holds the ask; no item when the caller gives none. */
  onPin?(): void;
  pinned?: boolean;
  onDelete?(): void;
  /** "Copy link" of the ask's menu; no item when the caller has no link to give. */
  onCopyLink?(): void;
  /** The link to the conversation, in Now. */
  openHref?: string;
  /** Carried to the article, so the list can find the card again after a change. */
  dataId?: number;
}

/** The phone layout of the app (its single mobile breakpoint): a menu opens as a bottom sheet there. */
const PHONE = "(max-width: 600px)";

function usePhone(): boolean {
  return useSyncExternalStore(
    (notify) => {
      const q = matchMedia(PHONE);
      q.addEventListener("change", notify);
      return () => q.removeEventListener("change", notify);
    },
    () => matchMedia(PHONE).matches,
    () => false,
  );
}

/** Icon is one 18px stroke icon of the action row. */
const Icon = ({ d }: { d: string }) => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={d} />
  </svg>
);

const URGENT_EDGE = "border-[color-mix(in_srgb,var(--color-danger)_55%,var(--color-border))]";

/** Answers is what an update of the ask says after the owner's questions: the line, the version trail and the summary of the answers, folded to 2 lines with "More". */
function Answers({ ask, className }: { ask: AskData; className?: string }) {
  const [more, setMore] = useState(false);
  const long = (ask.answers ?? "").length > 110 || (ask.answers ?? "").includes("\n");
  return (
    <div className={cx("mb-2 flex flex-col gap-1 text-13 leading-[18px] text-muted", className)}>
      <p className="m-0 font-semibold text-text">Updated after your questions</p>
      {ask.revision && ask.revision > 1 ? <p className="m-0">{`v${ask.revision}${ask.changed ? ` · changed: ${ask.changed}` : ""}`}</p> : null}
      <p className={cx("m-0 whitespace-pre-line [overflow-wrap:anywhere]", !more && "line-clamp-2")}>{ask.answers}</p>
      {long ? (
        <Button variant="text" size="inline" className="self-start -ml-8" aria-expanded={more} onClick={() => setMore(!more)}>
          {more ? "Less" : "More"}
        </Button>
      ) : null}
    </div>
  );
}

/** AskCard draws one ask. It keeps only what the eye needs (which panel is open); every change goes up through a callback. */
export function AskCard({ ask, where, labelId, as = "article", presets, busy, notice, onAnswer, onDismiss, onUndismiss, onSnooze, onReply, onPin, pinned, onDelete, onCopyLink, openHref, dataId }: AskCardProps) {
  const [panel, setPanel] = useState<"" | "reply" | "snooze" | "history" | "options">("");
  const [text, setText] = useState("");
  const [optionsOnSnooze, setOptionsOnSnooze] = useState(false);
  const root = useRef<HTMLElement | null>(null);
  const sheet = useRef<HTMLDivElement | null>(null);
  const gap = useRef<HTMLDivElement | null>(null);
  const phone = usePhone();
  const open = ask.state === "open";
  const draft = open ? ask.draft : undefined;
  const now = where === "now";
  // The composer of a thread is the reply there (no onReply), so a thread card has no quick reply of its own.
  const quickReply = (now || Boolean(onReply)) && !draft; // a draft is answered by Send or Don't send only
  const shut = () => {
    setPanel("");
    setOptionsOnSnooze(false);
  };
  const toggle = (p: typeof panel) => setPanel((cur) => (cur === p ? "" : p));

  // On a phone the sheet covers the foot of the screen, so the card gets a gap as tall as the sheet and scrolls up past it: no button of the card sits under the sheet.
  const sheetOpen = phone && (panel === "snooze" || panel === "options");
  useLayoutEffect(() => {
    if (!sheetOpen || !sheet.current || !gap.current) return;
    gap.current.style.height = `${sheet.current.offsetHeight}px`;
    gap.current.scrollIntoView({ block: "end" });
  }, [sheetOpen, optionsOnSnooze]);

  // A menu closes on a press outside the card, and on Escape.
  useEffect(() => {
    if (panel !== "snooze" && panel !== "options") return;
    const away = (e: Event) => root.current && !root.current.contains(e.target as Node) && shut();
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [panel]);

  const keys = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key === "Escape" && panel) return shut();
    const t = e.target as HTMLElement;
    // Nothing goes out in the owner's name from a key: a draft is sent only by its Send button.
    if (draft) return;
    if (e.metaKey || e.ctrlKey || e.altKey || t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.getAttribute("role") === "menuitem" || !open || busy) return;
    const k = e.key.toLowerCase();
    if (e.key === "Enter" && t === e.currentTarget) onAnswer({ choice: "recommended" });
    else if (k === "a" && ask.options.length > 1) onAnswer({ choice: "alternative", index: 1 });
    else if (k === "r" && quickReply) setPanel("reply");
    else if (k === "s") setPanel("snooze");
    else if (k === "x") onDismiss();
    else return;
    e.preventDefault();
  };

  const send = () => {
    const value = text.trim();
    if (!value) return;
    onAnswer({ choice: "custom", text: value });
    setText("");
    shut();
  };

  const item = (label: string, run: () => void) => (
    <MenuItem key={label} sheet={phone} onClick={() => (shut(), run())}>
      {label}
    </MenuItem>
  );
  const presetItems = presets.map((p) => item(p.label, () => onSnooze(p.key)));
  const menu = (items: ReactNode) => (
    <AskMenu sheet={phone} holder={sheet} shut={shut}>
      {items}
    </AskMenu>
  );

  const optionsMenu =
    panel !== "options"
      ? null
      : menu(
          optionsOnSnooze ? (
            presetItems
          ) : (
            <>
              {where === "conversation" ? (
                <MenuItem sheet={phone} onClick={() => setPanel("history")}>
                  History
                </MenuItem>
              ) : null}
              {open ? (
                <>
                  <MenuItem sheet={phone} onClick={() => setOptionsOnSnooze(true)}>
                    Snooze
                  </MenuItem>
                  {item("Dismiss", onDismiss)}
                </>
              ) : null}
              {ask.state === "dismissed" ? item("Reopen", onUndismiss) : null}
              {onCopyLink ? item("Copy link", onCopyLink) : null}
              {onPin ? item(pinned ? "Unpin" : "Pin", onPin) : null}
              {onDelete ? item("Delete", onDelete) : null}
            </>
          ),
        );

  const urgent = ask.urgent && open;
  const meta = [whoLine(ask.asker), ask.conversation?.title || (ask.conversation ? "Untitled conversation" : ""), clock(ask.created_at)].filter(Boolean).join(" · ");
  // In Now the text keeps clear of the right edge, where the prototype draws its expand arrow, so the lines break where the prototype's do.
  const clear = now && "pr-26";
  const shutState = ask.state === "dismissed" || ask.state === "closed";
  const replyLast = Boolean(onReply);
  const body = (
    <>
      {where === "conversation" ? (
        <div className="-mx-14 flex min-h-32 items-center gap-8 border-0 border-b border-solid border-border pr-6 pl-14 text-12">
          <span className="font-bold tracking-[.04em] text-text uppercase">Ask</span>
          {urgent ? <span className="flex-none font-bold tracking-[.04em] text-danger uppercase">· Urgent</span> : null}
          <span className="ml-auto flex items-center gap-2">
            <Button variant="text" size="inline" aria-label="Ask options" aria-haspopup="menu" aria-expanded={panel === "options"} onClick={() => (setOptionsOnSnooze(false), toggle("options"))}>
              <span aria-hidden="true">⋯</span>
            </Button>
          </span>
        </div>
      ) : null}
      {optionsMenu}
      <h3 id={labelId} className={cx("m-0 pt-12 pb-3 text-17 leading-[22px] font-semibold [overflow-wrap:anywhere]", clear)}>
        {ask.question}
      </h3>
      {open && ask.answers ? <Answers ask={ask} className={clear || undefined} /> : null}
      {ask.owners_call ? <p className={cx("m-0 mb-2 text-13 leading-[18px] text-muted [overflow-wrap:anywhere]", clear)}>{`Your call · ${ask.owners_call.kind}: ${ask.owners_call.reason}`}</p> : null}
      {now ? (
        <div className={cx("flex items-center gap-x-8 text-13 leading-[20px] text-muted", clear)}>
          {urgent ? <span className="flex-none font-semibold text-danger">Urgent</span> : null}
          <span className="min-w-0 truncate" title={meta}>
            {meta}
          </span>
        </div>
      ) : null}
      {open && ask.owner_reply ? <p className="m-0 mt-4 mb-2 rounded-full bg-selection px-10 py-px text-14 font-semibold text-muted">{waitingLine(ask)}</p> : null}
      {draft ? null : open ? (
        <div className={cx("mt-6 mb-9 flex flex-col gap-1 text-13 leading-[18px] text-muted", clear)}>
          {ask.options.map((o, i) => (
            <p key={i} className="m-0">
              <b className="font-semibold text-text">{i === 0 ? `Why ${o.label}:` : `Why ${o.label} is on the table:`}</b> {o.why}
            </p>
          ))}
        </div>
      ) : (
        <>
          <p className={cx("m-0 mt-4 rounded-full px-10 py-px text-14 font-semibold", shutState ? "bg-selection text-muted" : "bg-soft text-accent-text")}>{stateLine(ask)}</p>
          {ask.state === "closed" && ask.close_reason && ask.close_reason !== "replied" ? <p className="m-0 mt-6 text-13 text-muted">{`Why: ${ask.close_reason.replaceAll("_", " ")}`}</p> : null}
        </>
      )}
      {notice ? (
        <p className="m-0 mt-6 text-13 text-muted" role="status">
          {notice}
        </p>
      ) : null}
      {open ? (
        <div className="-mx-8 mb-14 flex flex-wrap" role="group" aria-label="Ask actions">
          {quickReply ? (
            <Button variant="text" size="inline" aria-expanded={panel === "reply"} onClick={() => toggle("reply")}>
              <Icon d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
              Quick reply
            </Button>
          ) : null}
          <Button variant="text" size="inline" aria-haspopup="menu" aria-expanded={panel === "snooze"} onClick={() => toggle("snooze")}>
            <Icon d="M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 7v5l3 2" />
            Snooze
          </Button>
          {openHref ? (
            <Button variant="text" size="inline" href={openHref}>
              <Icon d="M7 17L17 7M8 7h9v9" />
              Open
            </Button>
          ) : null}
          <Button variant="text" size="inline" onClick={onDismiss}>
            <Icon d="M18 6L6 18M6 6l12 12" />
            Dismiss
          </Button>
        </div>
      ) : null}
      {panel === "snooze" ? menu(presetItems) : null}
      {draft ? <DraftReview draft={draft} busy={busy} onSend={(text) => onAnswer({ choice: "recommended", text })} onDecline={() => onAnswer({ choice: "alternative", index: 1 })} /> : null}
      <div className="flex flex-col gap-8">
        {open && !draft
          ? ask.options.map((o, i) => (
              <Button key={i} size="option" variant={i === 0 ? "primary" : !replyLast && i === ask.options.length - 1 ? "dashed" : undefined} disabled={busy} onClick={() => onAnswer(i === 0 ? { choice: "recommended" } : { choice: "alternative", index: i })}>
                {o.label}
              </Button>
            ))
          : null}
        {onReply ? (
          <Button size="option" variant="dashed" onClick={onReply}>
            Reply in thread
          </Button>
        ) : null}
      </div>
      {panel === "reply" ? (
        <form
          className="mt-6 flex items-center gap-8"
          onSubmit={(e) => {
            e.preventDefault();
            send();
          }}
        >
          {/* eslint-disable-next-line convoz/no-raw-input -- a pill with no visible label (aria-label); Field draws a label above its input */}
          <input
            aria-label="Quick reply"
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
        </form>
      ) : null}
      {sheetOpen ? <div ref={gap} aria-hidden="true" /> : null}
      {panel === "history" ? (
        <ul className="m-0 mt-8 flex list-none flex-col gap-4 border-0 border-t border-solid border-border p-0 pt-8 text-13 text-muted" aria-label="History">
          {(ask.history ?? []).map((h, i) => (
            <li key={i}>{`${historyText(h, ask)} · ${clock(h.at)}`}</li>
          ))}
        </ul>
      ) : null}
    </>
  );

  const hold = (el: HTMLElement | null) => {
    root.current = el;
  };
  const classes = cx(
    "relative min-w-0 rounded-[14px] border border-solid px-14 pt-2 pb-14 focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-2",
    shutState ? "bg-surface" : "bg-raised",
    urgent ? URGENT_EDGE : "border-border",
    // An open card has always read like the app bar's "2 open" count (muted, 13px, tabular figures): its state class `open` met that rule of app.css. Kept as drawn.
    open && "text-13 text-muted tabular-nums",
  );
  if (as === "div") {
    return (
      <div ref={hold} className={classes} data-ask={dataId} onKeyDown={keys}>
        {body}
      </div>
    );
  }
  return (
    <article ref={hold} className={classes} aria-labelledby={labelId} tabIndex={-1} data-ask={dataId} onKeyDown={keys}>
      {body}
    </article>
  );
}
