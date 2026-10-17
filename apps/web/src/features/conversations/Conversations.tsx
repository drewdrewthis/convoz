import type { Conversation } from "@convoz/api-client";
import { ChatIcon } from "@convoz/ui/icons";
import { useVirtualizer } from "@tanstack/react-virtual";
import { memo, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type MouseEvent } from "react";
import { stripCf, whenLabel } from "../../shared/chat.ts";
import { humanError } from "../../shared/api.ts";
import { useNotice } from "../../shared/notice.tsx";
import { markUseful } from "../../shared/perf.ts";
import { data, useData, useLive } from "../../shared/data.ts";
import { markAllRead } from "./actions.ts";

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

  const [menu, setMenu] = useState<{ id: number; x: number; y: number } | null>(null);
  const ready = list !== null && me !== undefined;
  const rows = ready ? list : [];
  useEffect(() => {
    if (ready) markUseful();
  }, [ready]);

  // A long press or a right click on a row opens its menu: Mark all read.
  const onContextMenu = (event: MouseEvent<HTMLDivElement>) => {
    const row = (event.target as HTMLElement).closest<HTMLElement>("li[data-id]");
    if (!row) return;
    event.preventDefault();
    const box = row.getBoundingClientRect();
    setMenu({ id: Number(row.dataset.id), x: event.clientX || box.left + 16, y: event.clientY || box.bottom - 8 });
  };
  const read = async (id: number) => {
    setMenu(null);
    try {
      await markAllRead(id);
    } catch (err) {
      fail(humanError(err));
    }
  };
  return (
    <div id="chats" className="chats" aria-busy={ready ? undefined : true} onContextMenu={onContextMenu}>
      {menu ? <RowMenu at={menu} onRead={() => void read(menu.id)} onClose={() => setMenu(null)} /> : null}
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
    <li className={unread ? "unread" : undefined} data-id={c.id} data-index={index} ref={measure} style={style}>
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

/** RowMenu is the little menu of a conversation row. Escape or a click anywhere else closes it. */
function RowMenu({ at, onRead, onClose }: { at: { x: number; y: number }; onRead(): void; onClose(): void }) {
  const first = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    first.current?.focus();
    const away = (event: Event) => {
      if (!(event.target as HTMLElement).closest(".rowmenu")) onClose();
    };
    const key = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", key);
    };
  }, [onClose]);
  return (
    <div className="menu rowmenu" role="menu" aria-label="Conversation actions" style={{ position: "fixed", left: Math.min(at.x, innerWidth - 240), top: at.y }}>
      <button ref={first} type="button" role="menuitem" onClick={onRead}>
        Mark all read
      </button>
    </div>
  );
}
