import { AskMenu, MenuItem, usePhone, type SnoozePreset } from "@convoz/app-kit";
import { Button } from "@convoz/ui/Button";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { visit } from "../../shared/navigate.ts";

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
  /** The thread folded inside the item (FeedThread); the frame only gives it its place. */
  thread?: ReactNode;
  /** The snooze choices; none hides the Snooze button (no server support for that item). */
  snooze?: { presets: SnoozePreset[]; pick: (key: string) => void };
  /** The buttons, first the main one. */
  actions?: ReactNode;
  busy?: boolean;
  dataId?: number;
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
export function ItemFrame({ kind, title, context, tag, next, from, thread, snooze, actions, busy, dataId }: FrameProps) {
  const href = `/chats/${from.id}`;
  return (
    <article className="flex min-w-0 flex-col gap-4 rounded-[14px] border border-solid border-border bg-raised px-14 pt-12 pb-4" data-item={kind} data-ask={dataId} tabIndex={-1} aria-label={title}>
      <span className={`text-12 font-bold tracking-[.04em] uppercase ${kind === "blocking" ? "text-danger" : "text-muted"}`}>{kind === "blocking" ? "Blocking" : kind === "started" ? "Started" : "Done"}</span>
      <h3 className="m-0 text-17 leading-[22px] font-semibold [overflow-wrap:anywhere]">{title}</h3>
      {context || tag ? (
        <p className="m-0 text-13 leading-[18px] text-muted [overflow-wrap:anywhere]">
          {tag ? <b className="font-semibold text-danger">{`${tag} · `}</b> : null}
          {context}
        </p>
      ) : null}
      {next?.length ? <p className="m-0 text-12 text-muted [overflow-wrap:anywhere]">{`Next: ${next.join(" · ")}`}</p> : null}
      <p className="m-0 text-13 text-muted">
        {"From "}
        <a className="text-inherit underline" href={href} onClick={(e) => visit(e, href)}>
          {from.title || "Untitled conversation"}
        </a>
      </p>
      {thread}
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
