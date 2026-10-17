import type { Conversation } from "@convoz/api-client";
import { ChatIcon } from "@convoz/ui/icons";
import { useVirtualizer } from "@tanstack/react-virtual";
import { memo, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { stripCf, whenLabel } from "../../shared/chat.ts";
import { useNotice } from "../../shared/notice.tsx";
import { data, useData, useLive } from "../../shared/data.ts";

/** Lists longer than this are virtualized (design §12.2): only the rows near the screen are in the page. */
const VIRTUAL_ABOVE = 100;
const ROW_HEIGHT = 64;

/** Conversations is /chats: newest activity first, live (new messages, reads and new conversations reorder it with no reload). */
export function Conversations() {
  const { fail } = useNotice();
  const me = useData((s) => s.me?.identity.handle);
  const list = useData((s) => s.conversations);
  useLive(() => void data.loadConversations());
  useEffect(() => {
    data
      .loadMe()
      .then(() => data.loadConversations())
      .catch((err) => fail((err && err.message) || "Something went wrong. Try again."));
  }, [fail]);

  const ready = list !== null && me !== undefined;
  const rows = ready ? list : [];
  return (
    <div id="chats" className="chats" aria-busy={ready ? undefined : true}>
      <p id="chats-head" className="ghdr" hidden={!rows.length}>
        Conversations
      </p>
      {rows.length > VIRTUAL_ABOVE ? <VirtualList rows={rows} me={me!} /> : <PlainList rows={rows} me={me ?? ""} />}
      <div id="chats-empty" className="emptystate" hidden={!ready || rows.length !== 0}>
        <ChatIcon />
        <p className="lead">No chats yet. A chat starts with an agent.</p>
        <a className="btn primary" href="/chats/new">
          New conversation
        </a>
      </div>
    </div>
  );
}

function PlainList({ rows, me }: { rows: Conversation[]; me: string }) {
  return (
    <ul id="chat-list" className="chatlist" role="list" aria-label="Conversations" hidden={!rows.length}>
      {rows.map((c) => (
        <Row key={c.id} c={c} me={me} />
      ))}
    </ul>
  );
}

function VirtualList({ rows, me }: { rows: Conversation[]; me: string }) {
  const list = useRef<HTMLUListElement>(null);
  const [margin, setMargin] = useState(0);
  const scroller = () => list.current?.closest("main") ?? null;
  useLayoutEffect(() => {
    const main = scroller();
    if (main && list.current) setMargin(list.current.getBoundingClientRect().top - main.getBoundingClientRect().top + main.scrollTop);
  }, []);
  const v = useVirtualizer({ count: rows.length, getScrollElement: scroller, estimateSize: () => ROW_HEIGHT, overscan: 8, scrollMargin: margin, getItemKey: (i) => rows[i]!.id });
  return (
    <ul ref={list} id="chat-list" className="chatlist" role="list" aria-label="Conversations" style={{ position: "relative", height: v.getTotalSize() }}>
      {v.getVirtualItems().map((item) => (
        <Row
          key={item.key}
          c={rows[item.index]!}
          me={me}
          index={item.index}
          measure={v.measureElement}
          style={{ position: "absolute", top: 0, left: 0, right: 0, transform: `translateY(${item.start - margin}px)` }}
        />
      ))}
    </ul>
  );
}

interface RowProps {
  c: Conversation;
  me: string;
  index?: number;
  measure?: (el: Element | null) => void;
  style?: CSSProperties;
}

/** Row is one conversation; a row whose data did not change keeps its node, so a selection in it survives an update. */
const Row = memo(function Row({ c, me, index, measure, style }: RowProps) {
  const unread = c.unread > 0;
  const preview = c.last ? `${c.last.author_handle === me ? "You" : c.last.author_handle}: ${c.last.preview}` : "No messages yet";
  return (
    <li className={unread ? "unread" : undefined} data-index={index} ref={measure} style={style}>
      <a className="chatrow" href={`/chats/${c.id}`}>
        <div className="rowbody">
          <div className="rowtop">
            <h2 className="rowtitle">{stripCf(c.title ?? "") || "New conversation"}</h2>
            <span className="sp" />
            <time className="when">{whenLabel(c.last_activity_at)}</time>
          </div>
          <div className="preview">{preview}</div>
        </div>
        {unread ? (
          <span className="count">
            <span className="sr">Unread: </span>
            <span>{c.unread > 99 ? "99+" : String(c.unread)}</span>
          </span>
        ) : null}
      </a>
    </li>
  );
});
