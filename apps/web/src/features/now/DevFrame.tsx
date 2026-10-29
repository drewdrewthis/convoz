import { AskMenu, MenuItem, usePhone, type SnoozePreset } from "@convoz/app-kit";
import { Button } from "@convoz/ui/Button";
import { IconButton } from "@convoz/ui/IconButton";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { visit } from "../../shared/navigate.ts";
import { ItemTime } from "./DevTime.tsx";
import { copyUrl } from "../conversations/index.ts";
import { SnoozeGlyph } from "./DevIcons.tsx";

/** What one feed item shows. Every item of Now draws this frame; its state (started, blocking or done) sets the marker and the actions (owner, conv 179 msg 11603). */
export interface FrameProps {
  /** The state of the piece of work the item follows: started (fyi), blocking (needs the owner), done (fyi). */
  kind: "blocking" | "started" | "done";
  /** One line: the action, or the outcome. */
  title: string;
  /** A short why, what or recommendation. */
  context?: string;
  /** Small mark before the context, such as "Urgent". */
  tag?: string;
  /** The conversation the item belongs to: the From link. */
  from: { id: number; title: string };
  /** Later steps of the same plan, drawn quietly under the item. */
  next?: string[];
  /** The item sits in its own conversation: no From link and no Copy link. */
  inChat?: boolean;
  /** More rows for the ⋮ menu, such as Pin and Delete. */
  menu?: { label: string; run: () => void }[];
  /** A small line under the item, such as the reply count. */
  foot?: ReactNode;
  /** A quiet line under the context, such as "No update since 9:05 AM". */
  quiet?: string;
  /** An app an agent attached, drawn under the context. */
  app?: ReactNode;
  /** The thread folded inside the item (FeedThread); the frame only gives it its place. */
  thread?: ReactNode;
  /** The snooze choices; none hides the Snooze button (no server support for that item). */
  snooze?: { presets: SnoozePreset[]; pick: (key: string) => void };
  /** The buttons, first the main one. */
  actions?: ReactNode;
  busy?: boolean;
  dataId?: number;
  /** When the item last changed (ms); drawn as a relative time after the marker. */
  at: number;
  /** What "Copy link" opens: a message of the conversation (an ask, or the root of a thread), else the conversation itself. */
  link?: { message?: number };
}

/** ItemMenu is the ⋮ button of an item and its menu, with the same "Copy link" row the message menu has. */
function ItemMenu({ conversation, message, inChat, menu = [] }: { conversation: number; message?: number; inChat?: boolean; menu?: FrameProps["menu"] }) {
  const phone = usePhone();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement | null>(null);
  const sheet = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: Event) => root.current && !root.current.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);
  const url = `${location.origin}/chats/${conversation}${message ? `#m${message}` : ""}`;
  return (
    <div ref={root} className="relative">
      <IconButton variant="muted" size={44} glyph={20} stroke={2} label="Item actions" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" aria-hidden="true">
          <path d="M12 5h.01M12 12h.01M12 19h.01" />
        </svg>
      </IconButton>
      {open ? (
        <AskMenu sheet={phone} holder={sheet} shut={() => setOpen(false)}>
          {inChat ? null : (
            <MenuItem sheet={phone} onClick={() => (setOpen(false), copyUrl(url))}>
              Copy link
            </MenuItem>
          )}
          {menu?.map((m) => (
            <MenuItem key={m.label} sheet={phone} onClick={() => (setOpen(false), m.run())}>
              {m.label}
            </MenuItem>
          ))}
        </AskMenu>
      ) : null}
    </div>
  );
}

/** Snooze is the Snooze button with its menu of times; it closes on a press outside and on Escape, like the ask card's. */
function Snooze({ presets, pick, busy }: { presets: SnoozePreset[]; pick: (key: string) => void; busy?: boolean }) {
  const phone = usePhone();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement | null>(null);
  const sheet = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: Event) => root.current && !root.current.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);
  return (
    <div ref={root}>
      <Button variant="text" size="inline" disabled={busy} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <SnoozeGlyph />
        Snooze
      </Button>
      {open ? (
        <AskMenu sheet={phone} holder={sheet} shut={() => setOpen(false)}>
          {presets.map((p) => (
            <MenuItem key={p.key} sheet={phone} onClick={() => (setOpen(false), pick(p.key))}>
              {p.label}
            </MenuItem>
          ))}
        </AskMenu>
      ) : null}
    </div>
  );
}

/** ItemFrame is one feed item: Title, Context, From, the thread, then the actions and Snooze. */
export function ItemFrame({ kind, title, context, tag, next, from, inChat, menu, foot, quiet, app, thread, snooze, actions, busy, dataId, at, link }: FrameProps) {
  const href = `/chats/${from.id}`;
  return (
    <article className="flex min-w-0 flex-col gap-4 rounded-[14px] border border-solid border-border bg-raised px-14 pt-12 pb-4" data-item={kind} data-ask={dataId} tabIndex={-1} aria-label={title}>
      <div className="-mt-8 -mr-12 flex items-center justify-between gap-8">
        <span className={`text-12 font-bold tracking-[.04em] uppercase ${kind === "blocking" ? "text-danger" : "text-muted"}`}>
          {kind === "blocking" ? "Blocking" : kind === "started" ? "Started" : "Done"}
        </span>
        <span className="flex items-center">
          <ItemTime at={at} />
          <ItemMenu conversation={from.id} message={link?.message} inChat={inChat} menu={menu} />
        </span>
      </div>
      <h3 className="m-0 text-17 leading-[22px] font-semibold [overflow-wrap:anywhere]">{title}</h3>
      {context || tag ? (
        <p className="m-0 text-13 leading-[18px] text-muted [overflow-wrap:anywhere]">
          {tag ? <b className="font-semibold text-danger">{`${tag} · `}</b> : null}
          {context}
        </p>
      ) : null}
      {quiet ? <p className="m-0 text-12 text-muted">{quiet}</p> : null}
      {app}
      {next?.length ? <p className="m-0 text-12 text-muted [overflow-wrap:anywhere]">{`Next: ${next.join(" · ")}`}</p> : null}
      {inChat ? null : (
        <p className="m-0 text-13 text-muted">
          {"From "}
          <a className="text-inherit underline" href={href} onClick={(e) => visit(e, href)}>
            {from.title || "Untitled conversation"}
          </a>
        </p>
      )}
      {thread}
      {foot}
      {actions || snooze ? (
        <div className="-mx-8 flex flex-wrap items-center" role="group" aria-label="Actions">
          {actions}
          {snooze ? <Snooze presets={snooze.presets} pick={snooze.pick} busy={busy} /> : null}
        </div>
      ) : (
        <div className="pb-8" />
      )}
    </article>
  );
}
