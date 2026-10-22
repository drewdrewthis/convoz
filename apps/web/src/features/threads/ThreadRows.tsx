import type { Conversation } from "@convoz/api-client";
import { Button } from "@convoz/ui/Button";
import { useState } from "react";
import { stripCf } from "../../shared/chat.ts";
import { useThreadFold } from "./fold.ts";

type Thread = NonNullable<Conversation["threads"]>[number];

/** A thread is Older when nothing in it is new for the viewer (owner, msg 1855): conversations go Older by time, threads by unread. */
const isOldThread = (t: Thread): boolean => t.unread === 0;

const listed = (c: Conversation): Thread[] => (c.threads ?? []).filter((t) => t.reply_count > 0);

/** rowUnread is the count on a conversation row: its main chat, plus its threads while the owner has them folded away (msg 2055), so a hidden reply still counts. */
export const rowUnread = (c: Conversation, folded: boolean): number =>
  c.main_unread === undefined ? c.unread : c.main_unread + (folded ? listed(c).reduce((n, t) => n + t.unread, 0) : 0);

const rootWords = (t: Thread): string => stripCf(t.preview) || `${t.author.handle}: ${t.last_reply?.preview ?? ""}`;

/**
 * ThreadFold is the chevron on a conversation row that folds its thread rows away and back (owner, msg 1855). A conversation with no
 * thread rows has none. The choice is kept per conversation on this browser.
 */
export function ThreadFold({ c, className = "thrfold" }: { c: Conversation; className?: string }) {
  const folded = useThreadFold((s) => s.folded.includes(c.id));
  const toggle = useThreadFold((s) => s.toggle);
  if (!listed(c).length) return null;
  const title = stripCf(c.title ?? "") || "New conversation";
  return (
    <Button variant="text" size="inline" type="button" className={className} data-nodrag="" aria-expanded={!folded} aria-label={`${folded ? "Show" : "Fold"} threads of ${title}`} onClick={() => toggle(c.id)}>
      <span aria-hidden="true">{folded ? "▸" : "▾"}</span>
    </Button>
  );
}

/**
 * ThreadRows lists the threads of one conversation as indented sub-rows under its row (owner, msgs 266-267): "↳ root text", its own
 * unread count, newest reply first. Threads with no unread message fold under a per-conversation "Older · n" toggle, and the row's
 * ThreadFold hides them all unless `foldable` is off. A tap opens the thread.
 */
export function ThreadRows({ c, compact = false, foldable = true }: { c: Conversation; compact?: boolean; foldable?: boolean }) {
  const [open, setOpen] = useState(false);
  const folded = useThreadFold((s) => foldable && s.folded.includes(c.id));
  const all = listed(c);
  if (!all.length || folded) return null;
  const recent = all.filter((t) => !isOldThread(t));
  const older = all.filter((t) => isOldThread(t));
  const row = (t: Thread) => (
    <li key={t.root_id} className={`thrrow${t.unread > 0 ? " unread" : ""}`}>
      <a href={`/chats/${c.id}#reply=${t.root_id}`} aria-label={`Open thread: ${rootWords(t)}${t.unread > 0 ? `, ${t.unread} unread` : ""}`}>
        <span className="thrarrow" aria-hidden="true">↳</span>
        <span className="thrtext">{rootWords(t)}</span>
        {t.unread > 0 ? (
          <span className="count thrcount">
            <span className="sr">Unread: </span>
            {t.unread > 99 ? "99+" : t.unread}
          </span>
        ) : null}
      </a>
    </li>
  );
  return (
    <ul className={`thrlist${compact ? " compact" : ""}`} role="list" aria-label="Threads" data-conversation={c.id}>
      {recent.map(row)}
      {older.length ? (
        <>
          <li className="throlderli">
            <Button variant="text" size="inline" type="button" className="olderbtn throlder" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
              <span aria-hidden="true">{open ? "▾" : "▸"}</span>
              <span>{`Older · ${older.length}`}</span>
            </Button>
          </li>
          {open ? older.map(row) : null}
        </>
      ) : null}
    </ul>
  );
}
