import type { Conversation, Message } from "@convoz/api-client";
import { memo, useEffect, useState } from "react";
import { humanError } from "../../shared/api.ts";
import { stripCf } from "../../shared/chat.ts";
import { source } from "../../shared/data.ts";
import { useNotice } from "../../shared/notice.tsx";
import { markAllRead } from "../conversations/index.ts";
import { toast } from "../pins-stars/index.ts";
import { ThreadRows } from "../threads/index.ts";
import { titleOf } from "../rail/index.ts";
import { Button } from "@convoz/ui/Button";

/** Lines shown per card, and how many of the newest messages are read to find them (the owner's own and system lines are skipped). */
const LINES = 3;
const WINDOW = 20;

/** unreadRows are the conversations with unread main messages or unread thread replies, newest activity first. A muted conversation stays out. */
export function unreadRows(list: readonly Conversation[] | null): Conversation[] {
  return (list ?? [])
    .filter((c) => !c.muted_until && ((c.main_unread ?? c.unread) > 0 || (c.threads ?? []).some((t) => t.unread > 0)))
    .sort((a, b) => b.last_activity_at - a.last_activity_at);
}

/** ago is a short age: "now", "4m", "3h", "2d". */
export function ago(at: number, now = Date.now()): string {
  const m = Math.max(0, Math.round((now - at) / 60_000));
  return m < 1 ? "now" : m < 60 ? `${m}m` : m < 1440 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`;
}

const words = (m: Message): string => stripCf(m.body).replace(/\s+/g, " ").trim();

/** useLines reads the newest unread lines of each card; it reads again when a conversation has a new last message. */
function useLines(rows: Conversation[], me: string): Record<number, Message[]> {
  const [lines, setLines] = useState<Record<number, { key: string; list: Message[] }>>({});
  const key = rows.map((c) => `${c.id}:${c.last?.id ?? 0}:${c.main_unread ?? c.unread}`).join(",");
  useEffect(() => {
    for (const c of rows) {
      const k = `${c.last?.id ?? 0}:${c.main_unread ?? c.unread}`;
      if (lines[c.id]?.key === k || !(c.main_unread ?? c.unread)) continue;
      source.messages(c.id, { limit: WINDOW }).then(
        ({ messages }) => {
          const mine = messages.filter((m) => m.kind !== "system" && m.author.handle !== me && words(m));
          setLines((l) => ({ ...l, [c.id]: { key: k, list: mine.slice(-Math.min(LINES, c.main_unread ?? c.unread)).reverse() } }));
        },
        () => {},
      );
    }
  }, [key, me]);
  return Object.fromEntries(Object.entries(lines).map(([id, v]) => [id, v.list]));
}

/** Unread is the digest under the asks (owner, conv 1, msgs 535 and 562): a summary line, then one card per conversation with its newest unread lines. */
export const Unread = memo(function Unread({ rows, me }: { rows: Conversation[]; me: string }) {
  const { fail } = useNotice();
  const [busy, setBusy] = useState(false);
  const lines = useLines(rows, me);
  const total = rows.reduce((n, c) => n + c.unread, 0);
  const run = async (ids: number[], said: string) => {
    setBusy(true);
    try {
      await Promise.all(ids.map(markAllRead));
      toast(said);
    } catch (err) {
      fail(humanError(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section id="unread" className="block" aria-labelledby="unread-head">
      <p id="unread-head" className="ghdr">{`${total} unread in ${rows.length} ${rows.length === 1 ? "conversation" : "conversations"}`}</p>
      <ul className="ucards" role="list" aria-label="Unread conversations">
        {rows.map((c) => {
          const n = c.main_unread ?? c.unread;
          return (
            <li key={c.id} className="ucard" data-id={c.id}>
              <a className="uhead" href={`/chats/${c.id}`}>
                <span className="utop">
                  <h2 className="rowtitle">{titleOf(c)}</h2>
                  <time className="when">{ago(c.last_activity_at)}</time>
                  {n > 0 ? (
                    <span className="count">
                      <span className="sr">Unread: </span>
                      {n > 99 ? "99+" : n}
                    </span>
                  ) : null}
                </span>
                {(lines[c.id] ?? []).map((m) => (
                  <span key={m.id} className="uline">
                    <b>{m.author.handle}</b> {words(m)}
                  </span>
                ))}
              </a>
              {/* Only the threads with something new; the rest are in the conversation. */}
              <ThreadRows c={{ ...c, threads: (c.threads ?? []).filter((t) => t.unread > 0) }} compact />
              <button className="askbtn" type="button" disabled={busy} aria-label={`Mark ${titleOf(c)} read`} onClick={() => void run([c.id], "Marked read")}>
                Mark read
              </button>
            </li>
          );
        })}
      </ul>
      <div className="btns">
        <Button disabled={busy} onClick={() => void run(rows.map((c) => c.id), "Marked all read")}>
          Mark all read
        </Button>
      </div>
    </section>
  );
});
