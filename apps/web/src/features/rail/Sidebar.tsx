import { Button } from "@convoz/ui/Button";
import { IconButton } from "@convoz/ui/IconButton";
import { PlanIcon } from "../plan/index.ts";
import type { Conversation } from "@convoz/api-client";
import { Fragment, useCallback, useEffect, useMemo, useState, type KeyboardEvent, type MouseEvent } from "react";
import { humanError } from "../../shared/api.ts";
import { visit } from "../../shared/navigate.ts";
import { data, loadListOnMount, useData, useLive } from "../../shared/data.ts";
import { Now, needsYouCount, useNow } from "../now/index.ts";
import { toast } from "../pins-stars/index.ts";
import { useSearchUi } from "../search/index.ts";
import { startDrag, type Drop } from "./drag.ts";
import { Logo } from "./Logo.tsx";
import { RowMenu, type RowMenuAt } from "./RowMenu.tsx";
import { BackArrow, ChevronIcon, ComposeGlyph, CrewGlyph, InviteGlyph, FoldAllGlyph, ForwardArrow, DotsIcon, GripIcon, PanelGlyph, NowGlyph, SearchGlyph, StarIcon } from "./icons.tsx";
import { groups, isOlder, rowLabel, titleOf } from "./model.ts";
import { ThreadFold, ThreadRows, rowUnread, useThreadFold } from "../threads/index.ts";
import { useFold } from "./fold.ts";
import { useRailMode } from "./mode.ts";
import { moveRow, setStar, stepRow } from "./actions.ts";

// A row with thread rows carries their fold chevron at its right end, so its star and grip sit 24px further in.
const folds = (c: Conversation): boolean => (c.threads ?? []).some((t) => t.reply_count > 0);

// The rail's buttons that read as its rows (Now, "Conversations"): the app's Button in the size and colours of a rail row.
const PILL = "rnav min-h-32! justify-start! gap-8! text-left! text-14! text-text! hover:bg-[color-mix(in_srgb,var(--color-text)_6%,transparent)] aria-pressed:bg-selection";

const openedId = (): number => Number(/^\/chats\/(\d+)$/.exec(location.pathname)?.[1] ?? 0);

/**
 * Sidebar is the desktop rail (prototype v41): search and new conversation at the top, Now, the groups Starred and Conversations in the
 * owner's own order, the folded Older group, and Crew at the bottom. Drag a row, or Alt plus an arrow on it, to move it.
 * Now switches the rail to the Now list (proposal §1): the page keeps the open conversation, and a pick opens its conversation beside the
 * list. "Conversations", Escape in the rail, or Now again switch back. On the Now page the rail stays as it is: the page is that list.
 */
export default function Sidebar() {
  const list = useData((s) => s.conversations);
  const waiting = needsYouCount(useNow((s) => s.now), list);
  const crew = useData((s) => s.identities?.filter((p) => p.kind === "agent" && !p.disabled).length ?? null);
  const [olderOpen, setOlderOpen] = useState(false);
  const [said, setSaid] = useState("");
  const [focusId, setFocusId] = useState(0);
  const [menu, setMenu] = useState<RowMenuAt | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  const current = openedId();
  const { folded, toggle } = useFold();
  const onNowPage = document.body.dataset.page === "now";
  const showNow = useRailMode((s) => s.now) && !onNowPage;
  const setMode = useRailMode((s) => s.set);
  useLive(() => void data.loadConversations().catch(() => {}));
  useEffect(() => {
    Promise.all([data.loadMe(), loadListOnMount(), data.loadIdentities()]).catch(() => {});
  }, []);
  const g = useMemo(() => groups(list ?? []), [list]);

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
          const place = (data.store.getState().conversations ?? []).filter((c) => c.starred === d.starred && (d.starred || !isOlder(c))).sort((a, b) => b.rank - a.rank || b.id - a.id);
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
  const foldedIds = useThreadFold((s) => s.folded);
  const threaded = useMemo(() => (list ?? []).filter(folds).map((c) => c.id), [list]);
  const allFolded = threaded.length > 0 && threaded.every((id) => foldedIds.includes(id));
  const unreadOf = (c: Conversation) => rowUnread(c, foldedIds.includes(c.id));
  // Escape first closes what is open inside the rail (a field, a card's menu); then it leaves Now. The Now button keeps the focus.
  const escape = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key !== "Escape" || !showNow || e.defaultPrevented) return;
    const t = e.target as Element;
    if (t.closest("input, textarea, select, [contenteditable]") || t.closest("[data-ask]")?.querySelector("[aria-haspopup][aria-expanded='true']")) return;
    setMode(false);
    document.getElementById("rail-now")?.focus();
  };
  // A pick in the Now list opens its conversation without a page load, so the list beside it does not flash.
  const pick = (e: MouseEvent<HTMLElement>) => {
    const to = (e.target as Element).closest("a")?.getAttribute("href");
    if (to?.startsWith("/chats/")) visit(e, to);
  };
  const star = (c: Conversation) =>
    setStar(c.id, !c.starred).then(() => toast(c.starred ? "Unstarred" : "Starred"), fail);

  const row = (c: Conversation, grp: "starred" | "mid" | "older") => (
    <Fragment key={c.id}>
    <div className="rrow group/rrow" data-rid={grp === "older" ? undefined : c.id} data-grp={grp} data-current={c.id === current ? "true" : undefined} onPointerDown={grp === "older" ? undefined : (e) => startDrag(e, drop)} onKeyDown={(e) => key(e, c)}>
      <a className={`rgo${unreadOf(c) > 0 ? " unread" : ""}${c.muted_until ? " muted" : ""}`} id={`rr-${c.id}`} href={`/chats/${c.id}`} onClick={(e) => visit(e, `/chats/${c.id}`)} aria-current={c.id === current ? "page" : undefined} aria-label={rowLabel(c, unreadOf(c))} draggable={false}>
        <span className="rtitle">{titleOf(c)}</span>
        <PlanIcon id={c.id} />
        {unreadOf(c) > 0 ? (
          <span className="rcnt">
            <span className="sr">Unread: </span>
            {unreadOf(c) > 99 ? "99+" : unreadOf(c)}
          </span>
        ) : null}
      </a>
      <ThreadFold c={c} className="thrfold compact" />
      {/* The star takes the place of the count on hover or focus, so no box moves. A touch screen never hovers, so there it always shows (no :hover: iOS double-tap). */}
      <IconButton
        variant="muted"
        size={28}
        glyph="self"
        className={`absolute top-1/2 ${folds(c) ? "right-24" : "right-0"} -mt-14 pointer-events-none opacity-0 [transition:opacity_140ms_ease] data-on:text-warning [@media(hover:none)]:pointer-events-auto [@media(hover:none)]:opacity-100 group-hover/rrow:pointer-events-auto group-hover/rrow:opacity-100 group-focus-within/rrow:pointer-events-auto group-focus-within/rrow:opacity-100`}
        label={`${c.starred ? "Unstar" : "Star"} conversation ${titleOf(c)}`}
        data-nodrag=""
        data-on={c.starred ? "true" : undefined}
        onClick={() => void star(c)}
      >
        <StarIcon filled={c.starred} />
      </IconButton>
      {/* The dots sit left of the star and show with it. */}
      <IconButton
        variant="muted"
        size={28}
        glyph="self"
        className={`absolute top-1/2 ${folds(c) ? "right-52" : "right-28"} -mt-14 pointer-events-none opacity-0 [transition:opacity_140ms_ease] [@media(hover:none)]:pointer-events-auto [@media(hover:none)]:opacity-100 group-hover/rrow:pointer-events-auto group-hover/rrow:opacity-100 group-focus-within/rrow:pointer-events-auto group-focus-within/rrow:opacity-100`}
        id={`rm-${c.id}`}
        label={`More actions for ${titleOf(c)}`}
        aria-haspopup="menu"
        aria-expanded={menu?.c.id === c.id}
        data-nodrag=""
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          setMenu(menu?.c.id === c.id ? null : { c, x: r.left, y: r.bottom + 4 });
        }}
      >
        <DotsIcon />
      </IconButton>
      {grp === "older" ? null : (
        // The grip is for the keyboard and shows on focus only; w-22! because the size prop is square.
        <IconButton
          variant="muted"
          size={28}
          glyph="self"
          className={`absolute top-1/2 ${folds(c) ? "right-80" : "right-56"} -mt-14 w-22! cursor-grab touch-none pointer-events-none opacity-0 [transition:opacity_140ms_ease] focus-visible:opacity-100`}
          id={`rg-${c.id}`}
          label={`Reorder ${titleOf(c)}. Alt plus arrow keys move it.`}
        >
          <GripIcon />
        </IconButton>
      )}
    </div>
    <ThreadRows c={c} compact />
    </Fragment>
  );

  const foldButton = (
    <IconButton variant="dim" size={32} glyph="self" label={folded ? "Show sidebar" : "Hide sidebar"} aria-expanded={!folded} aria-keyshortcuts={"Meta+\\"} title={`${folded ? "Show" : "Hide"} sidebar · ⌘\\`} onClick={toggle}>
      <PanelGlyph />
    </IconButton>
  );
  if (folded) {
    return (
      <nav className="rail" aria-label="Conversations" data-testid="rail" data-folded="">
        {foldButton}
      </nav>
    );
  }

  return (
    <nav className="rail" aria-label="Conversations" data-testid="rail" onKeyDown={escape}>
      <div className="rail-top">
        {foldButton}
        <a className="brand" href="/">
          <Logo />
        </a>
        <IconButton variant="dim" size={32} glyph="self" label="Back" aria-keyshortcuts="Meta+[" title="Back · ⌘[" onClick={() => history.back()}>
          <BackArrow />
        </IconButton>
        <IconButton variant="dim" size={32} glyph="self" label="Forward" aria-keyshortcuts="Meta+]" title="Forward · ⌘]" onClick={() => history.forward()}>
          <ForwardArrow />
        </IconButton>
      </div>
      <div className="rail-tools">
        <button type="button" className="rsearch" aria-haspopup="dialog" aria-keyshortcuts="Control+K Meta+K" title="Search · ⌘K" onClick={(e) => useSearchUi.getState().show(e.currentTarget)}>
          <SearchGlyph />
          <span>Search</span>
        </button>
        <IconButton variant="bordered" size={32} glyph="self" href="/chats/new" label="New conversation" aria-keyshortcuts="Control+J Meta+J" title="New conversation · ⌘J">
          <ComposeGlyph />
        </IconButton>
        <IconButton variant="bordered" size={32} glyph="self" href="/crew?invite" label="Invite agent">
          <InviteGlyph />
        </IconButton>
        {threaded.length ? (
          <IconButton variant="bordered" size={32} glyph="self" label={allFolded ? "Show all threads" : "Fold all threads"} onClick={() => useThreadFold.getState().toggleAll(threaded)}>
            <FoldAllGlyph folding={!allFolded} />
          </IconButton>
        ) : null}
      </div>
      <div className="rail-scroll" data-rscroll="1">
        {/* The Now button keeps its place (the slot before it is empty in Conversations), so it keeps the focus across the switch. */}
        <div className="rmode">
          {showNow ? (
            <Button variant="text" size="inline" className={PILL} onClick={() => setMode(false)}>
              <BackArrow />
              <span>Conversations</span>
            </Button>
          ) : null}
          {onNowPage ? (
            <a className="rnav now" href="/" aria-current="page">
              <NowGlyph />
              <span>Now</span>
              {waiting ? <span className="rbadge">{String(waiting)}</span> : null}
            </a>
          ) : (
            <Button variant="text" size="inline" className={`${PILL} now`} id="rail-now" aria-pressed={showNow} aria-keyshortcuts="Meta+." title="Now · ⌘." onClick={() => setMode(!showNow)}>
              <NowGlyph />
              <span>Now</span>
              {waiting ? <span className="rbadge">{String(waiting)}</span> : null}
            </Button>
          )}
        </div>
        {showNow ? (
          <div className="rnow" onClick={pick}>
            <Now compact current={current} />
          </div>
        ) : (
          <>
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
          </>
        )}
      </div>
      <div className="rail-foot">
        <a className="rnav" href="/crew" aria-current={location.pathname.startsWith("/crew") ? "page" : undefined}>
          <CrewGlyph />
          <span>Crew</span>
          <span className="rsum">{crew ?? ""}</span>
        </a>
      </div>
      {menu ? <RowMenu at={menu} onClose={closeMenu} /> : null}
      <p className="sr" role="status" aria-live="polite">
        {said}
      </p>
    </nav>
  );
}
