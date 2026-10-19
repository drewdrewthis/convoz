import type { Conversation } from "@convoz/api-client";
import { ChatIcon } from "@convoz/ui/icons";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent } from "react";
import { createPortal } from "react-dom";
import { humanError } from "../../shared/api.ts";
import { useNotice } from "../../shared/notice.tsx";
import { markUseful } from "../../shared/perf.ts";
import { data, useData, useLive } from "../../shared/data.ts";
import { ChevronIcon, groups, moveRow, setMute, setStar, stepRow, titleOf, type Drop } from "../rail/index.ts";
import { toast } from "../pins-stars/index.ts";
import { markAllRead } from "./actions.ts";
import { Row, type ReorderMode } from "./Row.tsx";
import { Button } from "@convoz/ui/Button";

const VirtualList = lazy(() => import("./VirtualList.tsx"));

/** Lists longer than this are virtualized (design §12.2): only the rows near the screen are in the page. */
const VIRTUAL_ABOVE = 100;

/**
 * Conversations is /chats (prototype v41): Starred, then Conversations, both in the owner's own order (new activity never reorders
 * rows, I-21), then Older folded away. A long press on a row opens its actions; Reorder shows a handle on every row until Done.
 */
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
  const g = groups(rows);
  const [olderOpen, setOlderOpen] = useState(false);
  const [reorder, setReorder] = useState(false);
  const [said, setSaid] = useState("");
  const [focusId, setFocusId] = useState(0);
  const slot = useAppbarEnd();
  // After a keyboard move the row is a new node: put the focus back on its handle.
  useEffect(() => {
    if (focusId) document.getElementById(`lg-${focusId}`)?.focus();
  }, [focusId, list]);
  const drop = useCallback(
    (d: Drop) => {
      const by = (id: number) => titleOf((data.store.getState().conversations ?? []).find((c) => c.id === id)!);
      moveRow(d.id, d.starred, d.after).then(() => setSaid(`${by(d.id)} moved`), (err) => fail(humanError(err)));
    },
    [fail],
  );
  const step = useCallback(
    (e: ReactKeyboardEvent<HTMLElement>, c: Conversation) => {
      if (!e.altKey || e.metaKey || e.ctrlKey || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
      e.preventDefault();
      stepRow(c.id, e.key === "ArrowUp" ? -1 : 1).then((edge) => {
        setSaid(edge ? `${titleOf(c)} is already ${edge}` : `${titleOf(c)} moved`);
        setFocusId(c.id);
      }, (err) => fail(humanError(err)));
    },
    [fail],
  );
  const mode = useMemo<ReorderMode>(() => ({ on: reorder, drop, step }), [reorder, drop, step]);
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
    <div id="chats" className="chats" data-rscroll="1" aria-busy={ready ? undefined : true} onContextMenu={onContextMenu}>
      {reorder && slot
        ? createPortal(
            <button type="button" className="donebtn" onClick={() => (setReorder(false), setSaid("Order saved"))}>
              Done
            </button>,
            slot,
          )
        : null}
      <p className="sr" role="status" aria-live="polite">
        {reorder && !said ? "Reorder mode. Drag the handles to move conversations. Press Done when finished." : said}
      </p>
      {menu ? (
        <RowMenu
          at={menu}
          row={rows.find((c) => c.id === menu.id)}
          onRead={() => void read(menu.id)}
          onReorder={() => (setMenu(null), setSaid(""), setReorder(true))}
          onClose={() => setMenu(null)}
          onFail={(err) => fail(humanError(err))}
        />
      ) : null}
      {g.starred.length ? (
        <>
          <p id="starred-head" className="ghdr" data-ghdr="starred">
            Starred
          </p>
          <PlainList rows={g.starred} me={me ?? ""} label="Starred conversations" id="starred-list" grp="starred" mode={mode} />
        </>
      ) : null}
      <p id="chats-head" className="ghdr" data-ghdr="mid" hidden={!g.mid.length}>
        Conversations
      </p>
      {g.mid.length > VIRTUAL_ABOVE && !reorder ? (
        // Until the virtualizer's chunk arrives the long list shows in full, so the rows are never missing.
        <Suspense fallback={<PlainList rows={g.mid} me={me ?? ""} grp="mid" mode={mode} />}>
          <VirtualList rows={g.mid} me={me!} />
        </Suspense>
      ) : (
        <PlainList rows={g.mid} me={me ?? ""} grp="mid" mode={mode} />
      )}
      {g.older.length ? (
        <>
          <button type="button" id="older-toggle" className="olderbtn" aria-expanded={olderOpen} onClick={() => setOlderOpen((o) => !o)}>
            <ChevronIcon open={olderOpen} />
            <span>{`Older · ${g.older.length}`}</span>
          </button>
          {olderOpen ? <PlainList rows={g.older} me={me ?? ""} label="Older conversations" id="older-list" mode={mode} /> : null}
        </>
      ) : null}
      <div id="chats-empty" className="emptystate" hidden={!ready || rows.length !== 0}>
        <ChatIcon />
        <p className="lead">No conversations yet. Start one and type @ to bring in an agent.</p>
        <Button variant="primary" className="mt-8 min-w-[12rem] w-auto!" href="/chats/new">
          New conversation
        </Button>
      </div>
    </div>
  );
}

/** useAppbarEnd finds the right end of the top bar, where Done sits while the owner reorders. */
function useAppbarEnd(): Element | null {
  const [slot, setSlot] = useState<Element | null>(null);
  useEffect(() => setSlot(document.querySelector(".appbar-end")), []);
  return slot;
}

function PlainList({ rows, me, label = "Conversations", id = "chat-list", grp, mode }: { rows: Conversation[]; me: string; label?: string; id?: string; grp?: "starred" | "mid"; mode?: ReorderMode }) {
  return (
    <ul id={id} className="chatlist" role="list" aria-label={label} hidden={!rows.length}>
      {rows.map((c) => (
        <Row key={c.id} c={c} me={me} grp={grp} mode={mode} />
      ))}
    </ul>
  );
}

/** RowMenu is the little menu of a conversation row. Escape or a click anywhere else closes it. */
function RowMenu({ at, row, onRead, onReorder, onClose, onFail }: { at: { x: number; y: number }; row: Conversation | undefined; onRead(): void; onReorder(): void; onClose(): void; onFail(err: unknown): void }) {
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
  const act = (run: Promise<void>, said?: string) => {
    onClose();
    run.then(() => said && toast(said), onFail);
  };
  return (
    <div className="menu rowmenu" role="menu" aria-label="Conversation actions" style={{ position: "fixed", left: Math.min(at.x, innerWidth - 240), top: at.y }}>
      <button ref={first} type="button" role="menuitem" onClick={onRead}>
        Mark all read
      </button>
      {row ? (
        <>
          <button type="button" role="menuitem" onClick={() => act(setStar(row.id, !row.starred), row.starred ? "Unstarred" : "Starred")}>
            {row.starred ? "Unstar conversation" : "Star conversation"}
          </button>
          <button type="button" role="menuitem" onClick={() => act(setMute(row.id, !row.muted_until), row.muted_until ? "Unmuted" : "Muted")}>
            {row.muted_until ? "Unmute" : "Mute"}
          </button>
          <button type="button" role="menuitem" onClick={() => act(stepRow(row.id, -1).then(() => undefined))}>
            Move up
          </button>
          <button type="button" role="menuitem" onClick={() => act(stepRow(row.id, 1).then(() => undefined))}>
            Move down
          </button>
          <button type="button" role="menuitem" onClick={onReorder}>
            Reorder…
          </button>
        </>
      ) : null}
    </div>
  );
}
