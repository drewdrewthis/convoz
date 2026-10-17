import type { Message } from "@convoz/api-client";
import { useVirtualizer } from "@tanstack/react-virtual";
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { clock, initials, paletteOf, stripCf } from "../../shared/chat.ts";
import type { PendingSend } from "./store.ts";
import { Markdown } from "./Markdown.tsx";

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
  working: string | null;
  control: RefObject<TranscriptControl | null>;
  onEarlier(): Promise<void>;
  onRetry(cid: string): void;
  /** Open the details of an agent's message (its time is the button). */
  onDetails?(m: Message): void;
}

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
    out.push({ key: `m${m.id}`, author: m.author.handle, first: prev !== m.author.handle, message: m });
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
export function Transcript({ messages, pending, hasEarlier, me, opened, hint, working, control, onEarlier, onRetry, onDetails }: TranscriptProps) {
  const log = useRef<HTMLDivElement>(null);
  const items = useRef<HTMLDivElement>(null);
  const stuck = useRef(true);
  const seen = useRef(new Set<string>());
  const anchor = useRef<{ height: number; top: number } | null>(null);
  const [pill, setPill] = useState(false);
  const rows = useMemo(() => rowsOf(messages, pending, me), [messages, pending, me]);
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
    toBottom();
    requestAnimationFrame(() => stuck.current && toBottom());
  }, [opened]);

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
      <VirtualItems rows={rows} me={me} log={log} items={items} onRetry={onRetry} onDetails={onDetails} stuck={stuck} />
    ) : (
      <div ref={items} id="items" className="items">
        {rows.map((r) => (
          <MessageRow key={r.key} row={r} me={me} onRetry={onRetry} onDetails={onDetails} />
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

function VirtualItems({ rows, me, log, items, onRetry, onDetails, stuck }: { rows: Row[]; me: string; log: RefObject<HTMLDivElement | null>; items: RefObject<HTMLDivElement | null>; onRetry(cid: string): void; onDetails?(m: Message): void; stuck: RefObject<boolean> }) {
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
  return (
    <div ref={items} id="items" className="items" style={{ position: "relative", height: v.getTotalSize() }}>
      {v.getVirtualItems().map((item) => (
        <div key={item.key} data-index={item.index} ref={v.measureElement} style={{ position: "absolute", top: 0, left: 0, right: 0, transform: `translateY(${item.start - margin}px)` }}>
          <MessageRow row={rows[item.index]!} me={me} onRetry={onRetry} onDetails={onDetails} />
        </div>
      ))}
    </div>
  );
}

interface RowProps {
  row: Row;
  me: string;
  onRetry(cid: string): void;
  onDetails?(m: Message): void;
}

/** What the page says about an ask: where it stands. */
const ASK_LABEL: Record<string, string> = { open: "Open", answered: "Answered", dismissed: "Dismissed", closed: "Closed" };

/** A row that did not change keeps its node, so a selection in it survives. */
const sameRow = (a: RowProps, b: RowProps) =>
  a.me === b.me && a.onDetails === b.onDetails && a.row.key === b.row.key && a.row.first === b.row.first && a.row.message === b.row.message && a.row.pending?.state === b.row.pending?.state;

const MessageRow = memo(function MessageRow({ row, me, onRetry, onDetails }: RowProps) {
  const { message: m, pending: p } = row;
  if (m?.author.kind === "system") {
    return (
      <article className="msg system">
        <div className="sysline">{stripCf(m.body)}</div>
      </article>
    );
  }
  if (m) {
    const text = stripCf(m.body);
    const body = m.author.handle !== me && m.format === "markdown" ? <Markdown text={text} /> : <div className="text">{text}</div>;
    const stamp = clock(m.created_at);
    const asked = m.kind === "ask" && m.ask ? <div className={`askstate ${m.ask.state}`}>{ASK_LABEL[m.ask.state] ?? m.ask.state}</div> : null;
    const detail = onDetails && m.author.kind === "agent" ? () => onDetails(m) : undefined;
    return <Article author={m.author.handle} me={me} first={row.first} stamp={stamp} onStamp={detail} body={body} extra={asked} />;
  }
  const state =
    p!.state === "failed" ? (
      <div className="sendstate bad">
        Not sent
        <button className="retry" type="button" onClick={() => onRetry(p!.cid)}>
          Retry
        </button>
      </div>
    ) : (
      <div className="sendstate">Sending…</div>
    );
  return <Article author={me} me={me} first={row.first} stamp={clock(Date.now())} body={<div className="text">{stripCf(p!.body)}</div>} extra={state} />;
}, sameRow);

/** Article is one message: avatar, name and time (once per run), then the body. The letter is drawn, so it reads "@devtool 5:25 AM Hello". */
function Article({ author, me, first, stamp, onStamp, body, extra }: { author: string; me: string; first: boolean; stamp: string; onStamp?: () => void; body: ReactNode; extra?: ReactNode }) {
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
    <article className={`msg ${mine ? "mine" : "theirs"}${first ? " first" : ""}`}>
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
          </div>
        ) : null}{" "}
        {body}
        {extra ?? null}
      </div>
    </article>
  );
}
