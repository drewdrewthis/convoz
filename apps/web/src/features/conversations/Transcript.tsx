import type { Message } from "@convoz/api-client";
import { useVirtualizer } from "@tanstack/react-virtual";
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { AskInline } from "../now/index.ts";
import { clock, initials, paletteOf, stripCf } from "../../shared/chat.ts";
import type { PendingSend } from "./store.ts";
import { Markdown } from "./Markdown.tsx";
import { resume } from "./actions.ts";
import { EditedMark, MessageMenu } from "./messages/MessageMenu.tsx";
import { NoticeRow, pausedNow } from "./messages/Notice.tsx";
import { ReplyLine } from "../threads/index.ts";

/** A message that arrives while the log is within this many px of its bottom keeps the log at the bottom. */
const NEAR_BOTTOM = 80;
/** Longer transcripts are virtualized (design §12.2). */
const VIRTUAL_ABOVE = 100;

/** What the page can ask of the log. */
export interface TranscriptControl {
  /** Keep the newest end in view (the owner just sent). */
  stick(): void;
  /** Scroll to the newest end if the log is there already (the working note appeared). */
  followIfStuck(): void;
}

export interface TranscriptProps {
  /** Server messages, ascending by id. */
  messages: Message[];
  pending: PendingSend[];
  hasEarlier: boolean;
  me: string;
  /** The first page is in: open at the newest message. */
  opened: boolean;
  hint: boolean;
  /** The conversation, so a notice can act on it (Resume). */
  conversation: number;
  working: string | null;
  control: RefObject<TranscriptControl | null>;
  onEarlier(): Promise<void>;
  onRetry(cid: string): void;
  /** Open the details of an agent's message (its time is the button). */
  onDetails?(m: Message): void;
  /** A message to open at (a search result): the log scrolls it to the middle and marks it for a moment instead of going to the newest end. */
  focus?: number;
}

/** How long a message opened from a search result stays marked. */
const HL_MS = 2400;

interface Row {
  key: string;
  author: string;
  first: boolean;
  message?: Message;
  pending?: PendingSend;
}

/** rows lays the messages out the prototype's way: a run of messages by one author shows the avatar and name once. */
function rowsOf(messages: Message[], pending: PendingSend[], me: string): Row[] {
  const out: Row[] = [];
  let prev: string | null = null;
  for (const m of messages) {
    if (m.kind === "system") {
      out.push({ key: `m${m.id}`, author: "", first: false, message: m });
      prev = null; // a notice ends a run: the next message shows its author again
      continue;
    }
    // a reply that is also in the main list says so in its header, so it always has one
    out.push({ key: `m${m.id}`, author: m.author.handle, first: prev !== m.author.handle || Boolean(m.thread_root_id), message: m });
    prev = m.author.handle;
  }
  for (const p of pending) {
    out.push({ key: `p${p.cid}`, author: me, first: prev !== me, pending: p });
    prev = me;
  }
  return out;
}

/**
 * Transcript is the log "Messages": the page itself does not scroll, the log does. It opens at the newest message, follows new
 * ones while it is at the bottom, and otherwise shows "New message ↓" instead of jumping.
 */
export function Transcript({ messages, pending, hasEarlier, me, opened, hint, conversation, working, control, onEarlier, onRetry, onDetails, focus }: TranscriptProps) {
  const log = useRef<HTMLDivElement>(null);
  const items = useRef<HTMLDivElement>(null);
  const stuck = useRef(true);
  const seen = useRef(new Set<string>());
  const anchor = useRef<{ height: number; top: number } | null>(null);
  const [pill, setPill] = useState(false);
  const [hl, setHl] = useState<number | null>(null);
  const rows = useMemo(() => rowsOf(messages, pending, me), [messages, pending, me]);
  const paused = useMemo(() => pausedNow(messages), [messages]);
  const focusAt = focus ? rows.findIndex((r) => r.message?.id === focus) : -1;
  const shape = rows.map((r) => r.key + (r.pending?.state ?? "")).join();

  const toBottom = () => {
    const el = log.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    stuck.current = true;
    setPill(false);
  };
  control.current = {
    stick: () => {
      stuck.current = true;
    },
    followIfStuck: () => {
      if (stuck.current) toBottom();
    },
  };

  useEffect(() => {
    const el = log.current!;
    const onScroll = () => {
      const gap = el.scrollHeight - el.scrollTop - el.clientHeight;
      stuck.current = gap <= NEAR_BOTTOM;
      if (gap <= 8) setPill(false);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    const resized = new ResizeObserver(() => {
      if (stuck.current) el.scrollTop = el.scrollHeight;
    });
    resized.observe(el);
    return () => {
      el.removeEventListener("scroll", onScroll);
      resized.disconnect();
    };
  }, []);

  useLayoutEffect(() => {
    if (!opened) return;
    if (focusAt >= 0) {
      stuck.current = false; // opened at a search result: the effect below takes the log there
      return;
    }
    toBottom();
    requestAnimationFrame(() => stuck.current && toBottom());
  }, [opened]);

  // Opened from a search result: the message goes to the middle of the log and is marked for a moment. The log stays where it is
  // (not at the newest end) until the person scrolls back down.
  useEffect(() => {
    if (!opened || focusAt < 0) return;
    stuck.current = false;
    let frames = 0;
    let raf = 0;
    let timer = 0;
    const look = () => {
      const el = log.current?.querySelector<HTMLElement>(`[data-mid="${focus}"]`);
      if (el) {
        el.scrollIntoView({ block: "center" });
        setHl(focus!);
        timer = window.setTimeout(() => setHl(null), HL_MS);
      } else if (++frames < 120) {
        raf = requestAnimationFrame(look);
      }
    };
    raf = requestAnimationFrame(look);
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(timer);
    };
  }, [opened, focus, focusAt < 0]);

  // After every change of the rows: keep the place when older messages came in above, follow the end, or show the pill.
  useLayoutEffect(() => {
    const el = log.current!;
    const added = rows.filter((r) => !seen.current.has(r.key));
    seen.current = new Set(rows.map((r) => r.key));
    if (anchor.current) {
      el.scrollTop = anchor.current.top + (el.scrollHeight - anchor.current.height);
      anchor.current = null;
    } else if (stuck.current) {
      toBottom();
    } else if (added.some((r) => r.message && r.author !== me)) {
      setPill(true);
    }
  }, [shape]); // when the rows change, not on every render: typing must not move the log

  const earlier = async () => {
    const el = log.current!;
    anchor.current = { height: el.scrollHeight, top: el.scrollTop };
    try {
      await onEarlier();
    } catch {
      anchor.current = null;
    }
  };

  const body =
    rows.length > VIRTUAL_ABOVE ? (
      <VirtualItems rows={rows} me={me} paused={paused} conversation={conversation} log={log} items={items} onRetry={onRetry} onDetails={onDetails} stuck={stuck} hl={hl} focusAt={opened ? focusAt : -1} />
    ) : (
      <div ref={items} id="items" className="items">
        {rows.map((r) => (
          <MessageRow key={r.key} row={r} me={me} paused={paused} conversation={conversation} onRetry={onRetry} onDetails={onDetails} hl={hl} />
        ))}
      </div>
    );

  return (
    <div className="logwrap">
      <div ref={log} id="log" className="log" role="log" aria-label="Messages" aria-relevant="additions">
        <div id="earlier" className="earlier" hidden={!hasEarlier}>
          <button id="earlier-button" className="btn small quiet" type="button" onClick={earlier}>
            Earlier messages
          </button>
        </div>
        {body}
        <div id="hint" className="hintbox" hidden={!hint}>
          <p>Type @ to bring in an agent.</p>
        </div>
        <div id="working" className="working" role="status" hidden={!working}>
          {working ?? ""}
        </div>
      </div>
      <button id="pill" className="pill" type="button" hidden={!pill} onClick={toBottom}>
        New message ↓
      </button>
    </div>
  );
}

function VirtualItems({ rows, me, paused, conversation, log, items, onRetry, onDetails, stuck, hl, focusAt }: { rows: Row[]; me: string; paused: number; conversation: number; log: RefObject<HTMLDivElement | null>; items: RefObject<HTMLDivElement | null>; onRetry(cid: string): void; onDetails?(m: Message): void; stuck: RefObject<boolean>; hl: number | null; focusAt: number }) {
  const [margin, setMargin] = useState(0);
  useLayoutEffect(() => {
    const el = log.current;
    if (el && items.current) setMargin(items.current.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop);
  }, [log, items]);
  const v = useVirtualizer({
    count: rows.length,
    getScrollElement: () => log.current,
    estimateSize: () => 72,
    overscan: 10,
    scrollMargin: margin,
    getItemKey: (i) => rows[i]!.key,
    // measured rows change the height: stay at the newest end when the log is there
    onChange: () => {
      const el = log.current;
      if (el && stuck.current) el.scrollTop = el.scrollHeight;
    },
  });
  // A message to open at is far from the rows that are drawn: the list moves to it, and the log then centres it once drawn.
  useEffect(() => {
    if (focusAt >= 0) v.scrollToIndex(focusAt, { align: "center" });
  }, [focusAt >= 0]);
  return (
    <div ref={items} id="items" className="items" style={{ position: "relative", height: v.getTotalSize() }}>
      {v.getVirtualItems().map((item) => (
        <div key={item.key} data-index={item.index} ref={v.measureElement} style={{ position: "absolute", top: 0, left: 0, right: 0, transform: `translateY(${item.start - margin}px)` }}>
          <MessageRow row={rows[item.index]!} me={me} paused={paused} conversation={conversation} onRetry={onRetry} onDetails={onDetails} hl={hl} />
        </div>
      ))}
    </div>
  );
}

interface RowProps {
  row: Row;
  /** In the thread pane: no reply line and no "replied to a thread" tag. */
  threaded?: boolean;
  me: string;
  /** The id of the pause line that still holds, 0 for none. */
  paused: number;
  conversation: number;
  onRetry(cid: string): void;
  onDetails?(m: Message): void;
  /** The id of the message that is marked, if any. */
  hl?: number | null;
}

/** A row that did not change keeps its node, so a selection in it survives. */
const sameRow = (a: RowProps, b: RowProps) =>
  a.me === b.me && a.threaded === b.threaded && a.paused === b.paused && a.onDetails === b.onDetails && (a.hl === a.row.message?.id) === (b.hl === b.row.message?.id) && a.row.key === b.row.key && a.row.first === b.row.first && a.row.message === b.row.message && a.row.pending?.state === b.row.pending?.state;

const MessageRow = memo(function MessageRow({ row, threaded, me, paused, conversation, onRetry, onDetails, hl }: RowProps) {
  const { message: m, pending: p } = row;
  if (m?.kind === "system" || m?.author.kind === "system") {
    return <NoticeRow message={m} canResume={paused === m.id} onResume={() => void resume(conversation)} />;
  }
  if (m?.deleted) {
    return <Article author={m.author.handle} me={me} first={row.first} stamp={clock(m.created_at)} body={<div className="text tombstone">Message deleted</div>} />;
  }
  if (m) {
    const text = stripCf(m.body);
    const label = `ask-${m.id}`;
    const body = m.kind === "ask" && m.ask ? <AskInline ask={m.ask} labelId={label} /> : m.author.handle !== me && m.format !== "plain" ? <Markdown text={text} format={m.format} /> : <div className="text">{text}</div>;
    const edited = m.edited_at ? <EditedMark id={m.id} /> : null;
    const menu = <MessageMenu message={m} mine={m.author.handle === me} conversation={conversation} />;
    const detail = onDetails && m.author.kind === "agent" ? () => onDetails(m) : undefined;
    const replies = threaded || m.thread_root_id ? null : <ReplyLine message={m} conversation={conversation} />;
    const tag = !threaded && m.thread_root_id ? "replied to a thread" : undefined;
    return <Article author={m.author.handle} me={me} first={row.first} stamp={clock(m.created_at)} tag={tag} onStamp={detail} body={body} extra={<>{edited}{replies}</>} menu={menu} mid={m.id} marked={hl === m.id} labelledBy={m.kind === "ask" && m.ask ? label : undefined} />;
  }
  const state =
    p!.state === "failed" ? (
      <div className="sendstate bad">
        failed ·{" "}
        <button className="retry" type="button" onClick={() => onRetry(p!.cid)}>
          retry
        </button>
      </div>
    ) : (
      <div className="sendstate">sending</div>
    );
  return <Article author={me} me={me} first={row.first} stamp={clock(Date.now())} body={<div className="text">{stripCf(p!.body)}</div>} extra={state} />;
}, sameRow);

/** Article is one message: avatar, name and time (once per run), then the body. The letter is drawn, so it reads "@devtool 5:25 AM Hello". */
function Article({ author, me, first, stamp, tag, onStamp, body, extra, menu, mid, marked, labelledBy }: { author: string; me: string; first: boolean; stamp: string; tag?: string; onStamp?: () => void; body: ReactNode; extra?: ReactNode; menu?: ReactNode; mid?: number; marked?: boolean; labelledBy?: string }) {
  const mine = author === me;
  const avatar = mine ? (
    <span className="ava you" aria-hidden="true" data-l="Y" />
  ) : (
    <span className={`ava p${paletteOf(author)}`} aria-hidden="true" data-l={initials(author)} />
  );
  const name = mine ? (
    <span className="who">You</span>
  ) : (
    <span className="who">
      <span className="sr">@</span>
      {author}
    </span>
  );
  return (
    <article className={`msg ${mine ? "mine" : "theirs"}${first ? " first" : ""}`} data-mid={mid} data-hl={marked ? "true" : undefined} aria-labelledby={labelledBy}>
      <div className="gut">{first ? avatar : null}</div>
      <div className="main">
        {first ? (
          <div className="byline">
            {name}{" "}
            {stamp ? (
              onStamp ? (
                <button type="button" className="stamp stampbtn" aria-label="Message details" onClick={onStamp}>
                  <time>{stamp}</time>
                </button>
              ) : (
                <time className="stamp">{stamp}</time>
              )
            ) : null}
            {tag ? <span className="tag">{tag}</span> : null}
          </div>
        ) : null}{" "}
        {body}
        {extra ?? null}
      </div>
      {menu ?? null}
    </article>
  );
}

/** The messages of an open thread drawn as the main list draws them, for the thread pane: a pending reply shows "sending" or "failed · retry". */
export function ThreadBubbles({ messages, pending, me, conversation, onRetry }: { messages: Message[]; pending: PendingSend[]; me: string; conversation: number; onRetry(cid: string): void }) {
  const rows = useMemo(() => rowsOf(messages, pending, me), [messages, pending, me]);
  return (
    <>
      {rows.map((r) => (
        <MessageRow key={r.key} row={r} me={me} paused={0} conversation={conversation} onRetry={onRetry} threaded />
      ))}
    </>
  );
}
