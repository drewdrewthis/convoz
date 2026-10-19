import type { Message } from "@convoz/api-client";
import { useVirtualizer } from "@tanstack/react-virtual";
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { AppHost, ViaAppMark } from "../apps-host/index.ts";
import { ViaVoiceMark } from "../call/index.ts";
import { AskInline } from "../now/index.ts";
import { clock, initials, paletteOf, stripCf } from "../../shared/chat.ts";
import { useData } from "../../shared/data.ts";
import { PinMark } from "../pins-stars/index.ts";
import type { PendingSend } from "./store.ts";
import { Markdown } from "./Markdown.tsx";
import { resume } from "./actions.ts";
import { hasLink, LinkPreview } from "./messages/LinkPreview.tsx";
import { DeleteSheet, EditedMark, MessageMenu } from "./messages/MessageMenu.tsx";
import { NoticeRow, pausedNow } from "./messages/Notice.tsx";
import { PendingFiles, Uploads } from "./messages/Uploads.tsx";
import { SeenLine } from "./messages/SeenLine.tsx";
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
  /** The first message that was unread when the chat opened (see `firstUnread`): the "New messages" divider goes above it. Absent: no divider. */
  newFrom?: number | null;
  /** A message to open at (a search result): the log scrolls it to the middle and marks it for a moment instead of going to the newest end. */
  focus?: number;
}

/** Messages by one author further apart than this start a new group: the author line and the time show again. */
export const GROUP_GAP_MS = 5 * 60_000;

/** How long a message opened from a search result stays marked. */
const HL_MS = 2400;

interface Row {
  key: string;
  author: string;
  first: boolean;
  /** The "New messages" divider goes above this row: the first message that was unread when the chat opened. */
  fresh?: boolean;
  message?: Message;
  pending?: PendingSend;
}

/** rows lays the messages out the prototype's way: a run of messages by one author shows the avatar and name once. */
function rowsOf(messages: Message[], pending: PendingSend[], me: string, newFrom?: number | null): Row[] {
  const out: Row[] = [];
  let prev: string | null = null;
  let prevAt = 0;
  for (const m of messages) {
    if (m.kind === "system") {
      out.push({ key: `m${m.id}`, author: "", first: false, message: m });
      prev = null; // a notice ends a run: the next message shows its author again
      continue;
    }
    const fresh = m.id === newFrom;
    // a reply that is also in the main list says so in its header, so it always has one
    const first = prev !== m.author.handle || m.created_at - prevAt > GROUP_GAP_MS || fresh || Boolean(m.thread_root_id);
    out.push({ key: `m${m.id}`, author: m.author.handle, first, fresh, message: m });
    prev = m.author.handle;
    prevAt = m.created_at;
  }
  for (const p of pending) {
    out.push({ key: `p${p.cid}`, author: me, first: prev !== me || Date.now() - prevAt > GROUP_GAP_MS, pending: p });
    prev = me;
    prevAt = Date.now();
  }
  return out;
}

/** firstUnread is the first message from someone else after the read position, or null when nothing is unread (or there is no position). */
export function firstUnread(messages: Message[], readAt: number | undefined, me: string): number | null {
  if (readAt === undefined) return null;
  return messages.find((m) => m.id > readAt && m.kind !== "system" && m.author.handle !== me)?.id ?? null;
}

/**
 * Transcript is the log "Messages": the page itself does not scroll, the log does. It opens at the newest message, follows new
 * ones while it is at the bottom, and otherwise shows "New message ↓" instead of jumping.
 */
export function Transcript({ messages, pending, hasEarlier, me, opened, hint, conversation, working, control, onEarlier, onRetry, onDetails, focus, newFrom }: TranscriptProps) {
  const log = useRef<HTMLDivElement>(null);
  const items = useRef<HTMLDivElement>(null);
  // Opened at a search result, the log never starts at the newest end: rows that arrive (and a list virtualizer that measures them)
  // must not pull it there while it goes to the message. Without a message to open at, or once none is found, it follows the end.
  const stuck = useRef(!focus);
  const seen = useRef(new Set<string>());
  const anchor = useRef<{ height: number; top: number } | null>(null);
  /** Messages from others that came in while the log was scrolled up; the first of them is where the pill takes the owner. */
  const [pill, setPill] = useState(0);
  /** The log is more than a screen above its newest end: the round "Jump to latest" button shows (the same control as the pill). */
  const [away, setAway] = useState(false);
  const firstNew = useRef<number | null>(null);
  const [hl, setHl] = useState<number | null>(null);
  /** The opening snap is over: after the frame that follows the first one at the newest end, nothing moves the log by itself any more. */
  const [settled, setSettled] = useState(false);
  const rows = useMemo(() => rowsOf(messages, pending, me, newFrom), [messages, pending, me, newFrom]);
  const paused = useMemo(() => pausedNow(messages), [messages]);
  const focusAt = focus ? rows.findIndex((r) => r.message?.id === focus) : -1;
  const shape = rows.map((r) => r.key + (r.pending?.state ?? "")).join();

  const toBottom = () => {
    const el = log.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    stuck.current = true;
    clearPill();
  };
  const clearPill = () => {
    firstNew.current = null;
    setPill(0);
  };
  // The pill takes the owner to the first message that came in while they were reading above.
  const jump = () => {
    const first = firstNew.current ? log.current?.querySelector<HTMLElement>(`[data-mid="${firstNew.current}"]`) : null;
    if (!first) return toBottom();
    first.scrollIntoView({ block: "start" });
    clearPill();
  };
  control.current = {
    stick: () => {
      stuck.current = true;
    },
    followIfStuck: () => {
      if (stuck.current) toBottom();
    },
  };

  const virtual = rows.length > VIRTUAL_ABOVE;
  useEffect(() => {
    const el = log.current!;
    let top = el.scrollTop;
    const onScroll = () => {
      const gap = el.scrollHeight - el.scrollTop - el.clientHeight;
      // Only the person moving up lets go of the end. Content that grows below a still log (late-measured rows, an image or a font
      // that loads) also widens the gap, and must not read as "scrolled away".
      if (gap <= NEAR_BOTTOM) stuck.current = true;
      else if (el.scrollTop < top) stuck.current = false;
      top = el.scrollTop;
      setAway(gap > el.clientHeight);
      if (gap <= 8) clearPill();
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    // The log itself (a keyboard, a rotation) and its content (rows that are measured, images, fonts) change the height: follow the end.
    const resized = new ResizeObserver(() => {
      if (stuck.current) el.scrollTop = el.scrollHeight;
      top = el.scrollTop;
      setAway(el.scrollHeight - el.scrollTop - el.clientHeight > el.clientHeight);
    });
    resized.observe(el);
    if (items.current) resized.observe(items.current);
    return () => {
      el.removeEventListener("scroll", onScroll);
      resized.disconnect();
    };
  }, [virtual]); // the list swaps its container when it becomes virtual

  useLayoutEffect(() => {
    if (!opened) return setSettled(false);
    if (focusAt >= 0) {
      stuck.current = false; // opened at a search result: the effect below takes the log there
      return setSettled(true);
    }
    toBottom();
    requestAnimationFrame(() => {
      if (stuck.current) toBottom();
      setSettled(true);
    });
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
    } else {
      const theirs = added.filter((r) => r.message && r.author !== me);
      if (theirs.length) {
        firstNew.current ??= theirs[0]!.message!.id;
        setPill((n) => n + theirs.length);
      }
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
    virtual ? (
      <VirtualItems rows={rows} me={me} paused={paused} conversation={conversation} log={log} items={items} onRetry={onRetry} onDetails={onDetails} hl={hl} focusAt={opened ? focusAt : -1} />
    ) : (
      <div ref={items} id="items" className="items">
        {rows.map((r) => (
          <MessageRow key={r.key} row={r} me={me} paused={paused} conversation={conversation} onRetry={onRetry} onDetails={onDetails} hl={hl} />
        ))}
      </div>
    );

  return (
    <div className="logwrap">
      {/* data-opened: the chat has finished opening, including the last snap to the newest end; scrolling is safe from then on */}
      <div ref={log} id="log" className="log" role="log" aria-label="Messages" aria-relevant="additions" data-opened={opened && settled}>
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
      <button id="pill" className={pill ? "pill" : "pill round"} type="button" hidden={!pill && !away} aria-label={pill > 1 ? `${pill} new messages ↓` : pill ? "New message ↓" : "Jump to latest"} onClick={jump}>
        {pill ? `↓ ${pill} new` : "↓"}
      </button>
    </div>
  );
}

function VirtualItems({ rows, me, paused, conversation, log, items, onRetry, onDetails, hl, focusAt }: { rows: Row[]; me: string; paused: number; conversation: number; log: RefObject<HTMLDivElement | null>; items: RefObject<HTMLDivElement | null>; onRetry(cid: string): void; onDetails?(m: Message): void; hl: number | null; focusAt: number }) {
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
  a.me === b.me && a.threaded === b.threaded && a.paused === b.paused && a.onDetails === b.onDetails && (a.hl === a.row.message?.id) === (b.hl === b.row.message?.id) && a.row.fresh === b.row.fresh && a.row.key === b.row.key && a.row.first === b.row.first && a.row.message === b.row.message && a.row.pending?.state === b.row.pending?.state;

const MessageRow = memo(function MessageRow(props: RowProps) {
  return (
    <>
      {props.row.fresh ? (
        <div className="newline" role="separator" aria-label="New messages">
          <span>New</span>
        </div>
      ) : null}
      <RowBody {...props} />
    </>
  );
}, sameRow);

function RowBody({ row, threaded, me, paused, conversation, onRetry, onDetails, hl }: RowProps) {
  const { message: m, pending: p } = row;
  const pinned = useData((s) => Boolean(m && s.rows[conversation]?.pinned?.some((x) => x.id === m.id)));
  if (m?.kind === "system" || m?.author.kind === "system") {
    return <NoticeRow message={m} conversation={conversation} canResume={paused === m.id} onResume={() => void resume(conversation)} />;
  }
  if (m?.deleted) {
    return <Article person={m.author} me={me} first={row.first} stamp={clock(m.created_at)} body={<div className="text tombstone">Message deleted</div>} />;
  }
  if (m) {
    const text = stripCf(m.body);
    const label = `ask-${m.id}`;
    const format = m.author.handle !== me && m.format !== "plain" ? m.format : null;
    // only markdown draws an image of an upload in the body; plain text and markdownv2 leave it to the file list
    const files = m.uploads?.length ? <Uploads uploads={m.uploads} body={format === "markdown" ? m.body : ""} /> : null;
    const said = !text && files ? null : format ? <Markdown text={text} format={format} /> : <div className="text">{text}</div>;
    const askCard = m.kind === "ask" && m.ask ? <AskInline ask={m.ask} labelId={label} inThread={threaded} deleteSheet={(close) => <DeleteSheet message={m} close={close} />} /> : null;
    const body = askCard ?? (
      <>
        {said}
        {files}
      </>
    );
    const app = m.app && m.kind !== "ask" ? <AppHost app={m.app} messageId={m.id} agent={m.author} conversation={conversation} threadRoot={m.thread_root_id} /> : null;
    const edited = m.edited_at ? <><ViaAppMark message={m} /><ViaVoiceMark message={m} />{app}<EditedMark id={m.id} /></> : <><ViaAppMark message={m} /><ViaVoiceMark message={m} />{app}</>;
    // The ask card has its own ⋯; a second one over the same corner was the "another three dots".
    const menu = askCard ? undefined : <MessageMenu message={m} mine={m.author.handle === me} conversation={conversation} />;
    const detail = onDetails && m.author.kind === "agent" ? () => onDetails(m) : undefined;
    const replies = threaded || m.thread_root_id ? null : <ReplyLine message={m} conversation={conversation} />;
    const tag = !threaded && m.thread_root_id ? "replied to a thread" : undefined;
    return <Article person={m.author} me={me} first={row.first} stamp={clock(m.created_at)} tag={tag} onStamp={detail} body={body} extra={<>{m.kind !== "ask" && hasLink(text) ? <LinkPreview id={m.id} /> : null}{pinned ? <PinMark /> : null}{edited}{replies}{m.author.handle === me ? <SeenLine conversation={conversation} message={m} threaded={threaded} /> : null}</>} menu={menu} mid={m.id} marked={hl === m.id} labelledBy={m.kind === "ask" && m.ask ? label : undefined} />;
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
  const body = (
    <>
      {p!.body || !p!.files?.length ? <div className="text">{stripCf(p!.body)}</div> : null}
      {p!.files?.length ? <PendingFiles files={p!.files} /> : null}
    </>
  );
  return <Article person={{ handle: me, display_name: "" }} me={me} first={row.first} stamp={clock(Date.now())} body={body} extra={state} />;
}

interface Who {
  handle: string;
  display_name: string;
}

/** Article is one message: a run of messages by one author shows its author line once. An agent's line is avatar, name, @handle and time;
 * the owner's is the time alone, above the bubble ("You" is left for a screen reader). Reads "devtool @devtool 5:25 AM Hello". */
function Article({ person, me, first, stamp, tag, onStamp, body, extra, menu, mid, marked, labelledBy }: { person: Who; me: string; first: boolean; stamp: string; tag?: string; onStamp?: () => void; body: ReactNode; extra?: ReactNode; menu?: ReactNode; mid?: number; marked?: boolean; labelledBy?: string }) {
  const mine = person.handle === me;
  const time = !stamp ? null : onStamp ? (
    <button type="button" className="stamp stampbtn" aria-label="Message details" onClick={onStamp}>
      <time>{stamp}</time>
    </button>
  ) : (
    <time className="stamp">{stamp}</time>
  );
  return (
    <article className={`msg ${mine ? "mine" : "theirs"}${first ? " first" : ""}`} data-mid={mid} data-hl={marked ? "true" : undefined} aria-labelledby={labelledBy}>
      <div className="main">
        {first ? (
          <div className="byline">
            {mine ? (
              <span className="sr">You</span>
            ) : (
              <>
                <span className={`ava p${paletteOf(person.handle)}`} aria-hidden="true" data-l={initials(person.handle)} />
                <span className="author"><span className="who">{stripCf(person.display_name) || person.handle}</span> <span className="handle">@{person.handle}</span></span>
              </>
            )}{" "}
            {time}
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
