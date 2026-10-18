import type { Conversation } from "@convoz/api-client";
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { humanError } from "../../shared/api.ts";
import { data, useData, useLive } from "../../shared/data.ts";
import { toast } from "../pins-stars/index.ts";
import { useSearchUi } from "../search/index.ts";
import { startDrag, type Drop } from "./drag.ts";
import { Logo } from "./Logo.tsx";
import { BackArrow, ChevronIcon, ComposeGlyph, CrewGlyph, InviteGlyph, ForwardArrow, GripIcon, NowGlyph, SearchGlyph, StarIcon } from "./icons.tsx";
import { groups, rowLabel, titleOf } from "./model.ts";
import { moveRow, setStar, stepRow } from "./actions.ts";

const openedId = (): number => Number(/^\/chats\/(\d+)$/.exec(location.pathname)?.[1] ?? 0);

/**
 * Sidebar is the desktop rail (prototype v41): search and new conversation at the top, Now, the groups Starred and Conversations in the
 * owner's own order, the folded Older group, and Crew at the bottom. Drag a row, or Alt plus an arrow on it, to move it.
 */
export default function Sidebar() {
  const list = useData((s) => s.conversations);
  const me = useData((s) => s.me?.identity.handle ?? "");
  const crew = useData((s) => s.identities?.filter((p) => p.kind === "agent" && !p.disabled).length ?? null);
  const [olderOpen, setOlderOpen] = useState(false);
  const [said, setSaid] = useState("");
  const [focusId, setFocusId] = useState(0);
  const current = openedId();
  useLive(() => void data.loadConversations().catch(() => {}));
  useEffect(() => {
    Promise.all([data.loadMe(), data.loadConversations(), data.loadIdentities()]).catch(() => {});
  }, []);
  const g = useMemo(() => groups(list ?? [], "rank"), [list]);

  // After a keyboard move the row is a new node: put the focus back on its handle.
  useEffect(() => {
    if (focusId) document.getElementById(`rg-${focusId}`)?.focus();
  }, [focusId, list]);

  const fail = useCallback((err: unknown) => {
    const text = humanError(err);
    if (text) toast(text);
  }, []);
  const drop = useCallback(
    (d: Drop) => {
      const by = (id: number) => titleOf((data.store.getState().conversations ?? []).find((c) => c.id === id)!);
      moveRow(d.id, d.starred, d.after).then(
        () => {
          const place = (data.store.getState().conversations ?? []).filter((c) => c.starred === d.starred && (d.starred || !c.older)).sort((a, b) => b.rank - a.rank || b.id - a.id);
          setSaid(`${by(d.id)} moved to ${d.starred ? "Starred" : "Conversations"}, position ${place.findIndex((c) => c.id === d.id) + 1} of ${place.length}`);
        },
        fail,
      );
    },
    [fail],
  );
  const key = useCallback(
    (e: KeyboardEvent<HTMLElement>, c: Conversation) => {
      if (!e.altKey || e.metaKey || e.ctrlKey || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
      e.preventDefault();
      e.stopPropagation();
      stepRow(c.id, e.key === "ArrowUp" ? -1 : 1).then((edge) => {
        if (edge) setSaid(`${titleOf(c)} is already ${edge}`);
        else setSaid(`${titleOf(c)} moved`);
        setFocusId(c.id);
      }, fail);
    },
    [fail],
  );
  const star = (c: Conversation) =>
    setStar(c.id, !c.starred).then(() => toast(c.starred ? "Unstarred" : "Starred"), fail);

  const row = (c: Conversation, grp: "starred" | "mid" | "older") => (
    <div key={c.id} className="rrow" data-rid={grp === "older" ? undefined : c.id} data-grp={grp} data-current={c.id === current ? "true" : undefined} onPointerDown={grp === "older" ? undefined : (e) => startDrag(e, drop)} onKeyDown={(e) => key(e, c)}>
      <a className={`rgo${c.unread > 0 ? " unread" : ""}${c.muted_until ? " muted" : ""}`} id={`rr-${c.id}`} href={`/chats/${c.id}`} aria-current={c.id === current ? "page" : undefined} aria-label={rowLabel(c)} draggable={false}>
        <span className="rtitle">{titleOf(c)}</span>
        {c.unread > 0 ? (
          <span className="rcnt">
            <span className="sr">Unread: </span>
            {c.unread > 99 ? "99+" : c.unread}
          </span>
        ) : null}
      </a>
      <button className="rstar" type="button" aria-label={`${c.starred ? "Unstar" : "Star"} conversation ${titleOf(c)}`} title={`${c.starred ? "Unstar" : "Star"} conversation ${titleOf(c)}`} data-on={c.starred ? "true" : undefined} onClick={() => void star(c)}>
        <StarIcon filled={c.starred} />
      </button>
      {grp === "older" ? null : (
        <button className="rgrab" id={`rg-${c.id}`} type="button" aria-label={`Reorder ${titleOf(c)}. Alt plus arrow keys move it.`}>
          <GripIcon />
        </button>
      )}
    </div>
  );

  return (
    <nav className="rail" aria-label="Conversations" data-testid="rail">
      <div className="rail-top">
        <a className="brand" href="/">
          <Logo />
        </a>
        <button type="button" className="rbtn dim" aria-label="Back" aria-keyshortcuts="Meta+[" title="Back · ⌘[" onClick={() => history.back()}>
          <BackArrow />
        </button>
        <button type="button" className="rbtn dim" aria-label="Forward" aria-keyshortcuts="Meta+]" title="Forward · ⌘]" onClick={() => history.forward()}>
          <ForwardArrow />
        </button>
      </div>
      <div className="rail-tools">
        <button type="button" className="rsearch" aria-haspopup="dialog" aria-keyshortcuts="Control+K Meta+K" title="Search · ⌘K" onClick={(e) => useSearchUi.getState().show(e.currentTarget)}>
          <SearchGlyph />
          <span>Search</span>
        </button>
        <a className="rbtn bordered" href="/chats/new" aria-label="New conversation" aria-keyshortcuts="Control+J Meta+J" title="New conversation · ⌘J">
          <ComposeGlyph />
        </a>
        <a className="rbtn bordered" href="/crew?invite" aria-label="Invite agent" title="Invite agent">
          <InviteGlyph />
        </a>
      </div>
      <div className="rail-scroll" data-rscroll="1">
        <a className="rnav now" href="/" aria-current={location.pathname === "/" ? "page" : undefined}>
          <NowGlyph />
          <span>Now</span>
        </a>
        {g.starred.length ? (
          <div className="rgroup" role="group" aria-label="Starred">
            <div className="rghdr" data-ghdr="starred">
              Starred
            </div>
            {g.starred.map((c) => row(c, "starred"))}
          </div>
        ) : null}
        {g.mid.length || !g.starred.length ? (
          <div className="rgroup" role="group" aria-label="Conversations">
            <a className="rghdr" data-ghdr="mid" href="/chats" style={{ textDecoration: "none" }}>
              Conversations
            </a>
            {g.mid.map((c) => row(c, "mid"))}
          </div>
        ) : null}
        {g.older.length ? (
          <div className="rgroup" role="group" aria-label="Older">
            <button type="button" className="rolder" aria-expanded={olderOpen} onClick={() => setOlderOpen((o) => !o)}>
              <ChevronIcon open={olderOpen} />
              <span>{`Older · ${g.older.length}`}</span>
            </button>
            {olderOpen ? g.older.map((c) => row(c, "older")) : null}
          </div>
        ) : null}
      </div>
      <div className="rail-foot">
        <a className="rnav" href="/crew" aria-current={location.pathname.startsWith("/crew") ? "page" : undefined}>
          <CrewGlyph />
          <span>Crew</span>
          <span className="rsum">{crew ?? ""}</span>
        </a>
      </div>
      <p className="sr" role="status" aria-live="polite">
        {said}
      </p>
    </nav>
  );
}
