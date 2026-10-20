import type { Conversation } from "@convoz/api-client";
import { useState } from "react";
import { stripCf } from "../../shared/chat.ts";

type Thread = NonNullable<Conversation["threads"]>[number];

/** A thread is Older by the conversation rule: no reply since this morning (the viewer's own time zone). */
const isOldThread = (t: Thread, now = Date.now()): boolean => t.last_reply_at < new Date(now).setHours(0, 0, 0, 0);

const rootWords = (t: Thread): string => stripCf(t.preview) || `${t.author.handle}: ${t.last_reply?.preview ?? ""}`;

/**
 * ThreadRows lists the threads of one conversation as indented sub-rows under its row (owner, msgs 266-267): "↳ root text", its own
 * unread count, newest reply first. Threads quiet since yesterday fold under a per-conversation "Older · n" toggle. A tap opens the thread.
 */
export function ThreadRows({ c, compact = false }: { c: Conversation; compact?: boolean }) {
  const [open, setOpen] = useState(false);
  const all = (c.threads ?? []).filter((t) => t.reply_count > 0);
  if (!all.length) return null;
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
            <button type="button" className="olderbtn throlder" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
              <span aria-hidden="true">{open ? "▾" : "▸"}</span>
              <span>{`Older · ${older.length}`}</span>
            </button>
          </li>
          {open ? older.map(row) : null}
        </>
      ) : null}
    </ul>
  );
}
