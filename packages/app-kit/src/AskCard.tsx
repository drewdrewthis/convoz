import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";

/* The ask card: one question an agent put to the owner, with the answers it offers. Now and a conversation draw the same card.
 * The types are local on purpose: this package knows no API client, so the app maps its data to these shapes. */

export interface AskPerson {
  handle: string;
  display_name: string;
  kind: string;
}

export interface AskHistoryItem {
  event: string;
  by?: AskPerson;
  at: number;
}

export interface AskData {
  question: string;
  urgent: boolean;
  /** Why only the owner can decide. Absent on an ask from before the field. */
  owners_call?: { kind: string; reason: string };
  state: string;
  close_reason?: string;
  options: { label: string; why: string }[];
  chosen?: { kind: string };
  answer?: string;
  created_at: number;
  asker: AskPerson;
  conversation?: { title: string | null };
  history?: AskHistoryItem[];
}

export interface SnoozePreset {
  key: string;
  label: string;
}

export interface Answer {
  choice: "recommended" | "alternative" | "custom";
  index?: number;
  text?: string;
}

export interface AskCardProps {
  ask: AskData;
  /** now: the card of the Now list (who asked, which conversation, quick reply). conversation: the card in the transcript (History, Ask options). */
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

/** whoLine is how a person is named: "Drew", or "Devtool @devtool" for an agent (an agent is never shown by its name alone). */
export function whoLine(p: AskPerson): string {
  if (p.kind === "agent") return p.display_name ? `${p.display_name} @${p.handle}` : `@${p.handle}`;
  return p.display_name || `@${p.handle}`;
}

const clock = (at: number) => new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

/** stateLine says where a closed ask stands, or "" for an open one. */
export function stateLine(a: AskData): string {
  switch (a.state) {
    case "answered":
      return `${a.chosen?.kind === "custom" ? "Replied" : "Answered"} · ${a.answer ?? ""}`;
    case "dismissed":
      return "Dismissed";
    case "closed":
      return "Closed";
  }
  return "";
}

const HISTORY: Record<string, string> = { create: "Asked", answer: "Answered", dismiss: "Dismissed", undismiss: "Reopened", withdraw: "Withdrawn", close: "Closed" };

function historyText(h: AskHistoryItem, a: AskData): string {
  const who = h.by ? ` by ${whoLine(h.by)}` : "";
  return `${HISTORY[h.event] ?? h.event}${who}${h.event === "answer" && a.answer ? ` · ${a.answer}` : ""}`;
}

/** Icon is one 18px stroke icon of the action row. */
const Icon = ({ d }: { d: string }) => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={d} />
  </svg>
);

/** AskCard draws one ask. It keeps only what the eye needs (which panel is open); every change goes up through a callback. */
export function AskCard({ ask, where, labelId, as = "article", presets, busy, notice, onAnswer, onDismiss, onUndismiss, onSnooze, onReply, onPin, pinned, onDelete, onCopyLink, openHref, dataId }: AskCardProps) {
  const [panel, setPanel] = useState<"" | "reply" | "snooze" | "history" | "options">("");
  const [text, setText] = useState("");
  const [optionsOnSnooze, setOptionsOnSnooze] = useState(false);
  const root = useRef<HTMLElement | null>(null);
  const open = ask.state === "open";
  // The composer of a thread is the reply there (no onReply), so a thread card has no quick reply of its own.
  const quickReply = where === "now" || Boolean(onReply);
  const shut = () => {
    setPanel("");
    setOptionsOnSnooze(false);
  };
  const toggle = (p: typeof panel) => setPanel((cur) => (cur === p ? "" : p));

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

  const menu = (items: ReactNode) => (
    <div className="askmenu" role="menu">
      {items}
    </div>
  );
  const presetItems = presets.map((p) => (
    <button key={p.key} role="menuitem" type="button" onClick={() => (shut(), onSnooze(p.key))}>
      {p.label}
    </button>
  ));

  const Tag = as;
  const urgent = ask.urgent && open;
  const meta = [whoLine(ask.asker), ask.conversation?.title || (ask.conversation ? "Untitled conversation" : ""), clock(ask.created_at)].filter(Boolean).join(" · ");
  const body = (
    <>
      {where === "conversation" ? (
        <div className="askbar">
          <span className="asklabel">Ask</span>
          {urgent ? <span className="askurgent">· Urgent</span> : null}
          <span className="askbar-end">
            <button className="askbtn" type="button" aria-expanded={panel === "history"} onClick={() => toggle("history")}>
              History
            </button>
            {open || ask.state === "dismissed" || onCopyLink ? (
              <button className="askbtn" type="button" aria-label="Ask options" aria-haspopup="menu" aria-expanded={panel === "options"} onClick={() => (setOptionsOnSnooze(false), toggle("options"))}>
                <span aria-hidden="true">⋯</span>
              </button>
            ) : null}
          </span>
        </div>
      ) : null}
      <h3 id={labelId} className="askq">
        {ask.question}
      </h3>
      {ask.owners_call ? <p className="askcall">{`Your call · ${ask.owners_call.kind}: ${ask.owners_call.reason}`}</p> : null}
      {where === "now" ? (
        <div className="askmeta">
          {urgent ? <span className="askurgent">Urgent</span> : null}
          <span className="askmeta-text" title={meta}>
            {meta}
          </span>
        </div>
      ) : null}
      {open ? (
        <div className="askwhys">
          {ask.options.map((o, i) => (
            <p key={i}>
              <b>{i === 0 ? `Why ${o.label}:` : `Why ${o.label} is on the table:`}</b> {o.why}
            </p>
          ))}
        </div>
      ) : (
        <>
          <p className={`askstate ${ask.state}`}>{stateLine(ask)}</p>
          {ask.state === "closed" && ask.close_reason ? <p className="asknote">{`Why: ${ask.close_reason.replaceAll("_", " ")}`}</p> : null}
        </>
      )}
      {notice ? (
        <p className="asknote" role="status">
          {notice}
        </p>
      ) : null}
      {open ? (
        <div className="askacts" role="group" aria-label="Ask actions">
          {quickReply ? (
            <button className="askbtn" type="button" aria-expanded={panel === "reply"} onClick={() => toggle("reply")}>
              <Icon d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
              Quick reply
            </button>
          ) : null}
          <button className="askbtn" type="button" aria-haspopup="menu" aria-expanded={panel === "snooze"} onClick={() => toggle("snooze")}>
            <Icon d="M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 7v5l3 2" />
            Snooze
          </button>
          {openHref ? (
            <a className="askbtn" href={openHref}>
              <Icon d="M7 17L17 7M8 7h9v9" />
              Open
            </a>
          ) : null}
          <button className="askbtn" type="button" onClick={onDismiss}>
            <Icon d="M18 6L6 18M6 6l12 12" />
            Dismiss
          </button>
        </div>
      ) : null}
      <div className="askopts">
        {open
          ? ask.options.map((o, i) => (
              <button key={i} className={`askopt${i === 0 ? " rec" : ""}`} type="button" disabled={busy} onClick={() => onAnswer(i === 0 ? { choice: "recommended" } : { choice: "alternative", index: i })}>
                {o.label}
              </button>
            ))
          : null}
        {onReply ? (
          <button className="askopt" type="button" onClick={onReply}>
            Reply in thread
          </button>
        ) : null}
      </div>
      {panel === "reply" ? (
        <form
          className="askreply"
          onSubmit={(e) => {
            e.preventDefault();
            send();
          }}
        >
          <input aria-label="Quick reply" type="text" autoFocus value={text} maxLength={4000} onChange={(e) => setText(e.target.value)} />
          <button className="askbtn primary" type="submit" disabled={busy || !text.trim()}>
            Send
          </button>
        </form>
      ) : null}
      {panel === "snooze" ? menu(presetItems) : null}
      {panel === "options" ? (
        optionsOnSnooze ? (
          menu(presetItems)
        ) : (
          menu(
            <>
              {open ? (
                <>
                  <button role="menuitem" type="button" onClick={() => setOptionsOnSnooze(true)}>
                    Snooze
                  </button>
                  <button role="menuitem" type="button" onClick={() => (shut(), onDismiss())}>
                    Dismiss
                  </button>
                </>
              ) : null}
              {ask.state === "dismissed" ? (
                <button role="menuitem" type="button" onClick={() => (shut(), onUndismiss())}>
                  Reopen
                </button>
              ) : null}
              {onCopyLink ? (
                <button role="menuitem" type="button" onClick={() => (shut(), onCopyLink())}>
                  Copy link
                </button>
              ) : null}
              {onPin ? (
                <button role="menuitem" type="button" onClick={() => (shut(), onPin())}>
                  {pinned ? "Unpin" : "Pin"}
                </button>
              ) : null}
              {onDelete ? (
                <button role="menuitem" type="button" onClick={() => (shut(), onDelete())}>
                  Delete
                </button>
              ) : null}
            </>,
          )
        )
      ) : null}
      {panel === "history" ? (
        <ul className="askhist" aria-label="History">
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
  if (Tag === "div") {
    return (
      <div ref={hold} className={`askcard ${where} ${ask.state}${ask.urgent && open ? " urgent" : ""}`} data-ask={dataId} onKeyDown={keys}>
        {body}
      </div>
    );
  }
  return (
    <article
      ref={hold}
      className={`askcard ${where} ${ask.state}${ask.urgent && open ? " urgent" : ""}`}
      aria-labelledby={labelId}
      tabIndex={-1}
      data-ask={dataId}
      onKeyDown={keys}
    >
      {body}
    </article>
  );
}
