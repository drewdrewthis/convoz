import type { Conversation, Message } from "@convoz/api-client";
import { memo, useEffect, useMemo, useState } from "react";
import { humanError } from "../../shared/api.ts";
import { stripCf } from "../../shared/chat.ts";
import { source } from "../../shared/data.ts";
import { visit } from "../../shared/navigate.ts";
import { useNotice } from "../../shared/notice.tsx";
import { markAllRead } from "../conversations/index.ts";
import { toast } from "../pins-stars/index.ts";
import { titleOf } from "../rail/index.ts";
import { Button } from "@convoz/ui/Button";

/** How many of the newest messages are read to tell what is new in a conversation. */
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

/** One line of a card: who said it and what. */
interface Line {
  author: string;
  text: string;
}
/** A conversation with the one message that put it under Needs you or Replies to you. */
export interface Item {
  c: Conversation;
  line: Line;
}
/** A conversation that is only news: who spoke, for its one line. */
export interface Quiet {
  c: Conversation;
  who: string;
}
export interface Triage {
  mentions: Item[];
  replies: Item[];
  rest: Quiet[];
}

const lineOf = (m: Message): Line => ({ author: m.author.handle, text: words(m) });

/**
 * triage sorts the unread conversations by what the owner must do (owner msgs 535, 562): a message that @mentions the owner needs them;
 * an answer to something the owner said (a message of theirs before the new ones, or a thread they started) is a reply; the rest is news.
 * `lines` is the newest window of messages per conversation. A conversation not read yet is news until it is; so is one whose only new messages
 * are asks or system lines, so Mark all read can clear it.
 */
export function triage(rows: readonly Conversation[], lines: Record<number, Message[]>, me: string): Triage {
  const out: Triage = { mentions: [], replies: [], rest: [] };
  const at = new RegExp(`(^|[^\\w-])@${me.replace(/[^\w-]/g, "")}(?![\\w-])`, "i");
  for (const c of rows) {
    const n = c.main_unread ?? c.unread;
    const win = n > 0 ? lines[c.id] : [];
    if (!win) {
      out.rest.push({ c, who: c.last?.author_handle ?? "" });
      continue;
    }
    const fresh = (n > 0 ? win.slice(-n) : []).filter((m) => m.kind !== "system" && m.kind !== "ask" && m.author.handle !== me && words(m));
    const threads = (c.threads ?? []).filter((t) => t.unread > 0);
    const mention = fresh.filter((m) => m.mentions?.some((x) => x.handle === me) || (me && at.test(m.body))).pop();
    if (mention) {
      out.mentions.push({ c, line: lineOf(mention) });
      continue;
    }
    const spoke = n > 0 && win.slice(0, win.length - n).some((m) => m.author.handle === me);
    const mineThread = threads.find((t) => t.author.handle === me);
    if (fresh.length && spoke) out.replies.push({ c, line: lineOf(fresh[fresh.length - 1]!) });
    else if (mineThread) out.replies.push({ c, line: mineThread.last_reply ? { author: mineThread.last_reply.author.handle, text: stripCf(mineThread.last_reply.preview) } : fresh.length ? lineOf(fresh[fresh.length - 1]!) : { author: mineThread.author.handle, text: stripCf(mineThread.preview) } });
    else out.rest.push({ c, who: [...new Set(fresh.map((m) => m.author.handle))].join(", ") || c.last?.author_handle || "" });
  }
  return out;
}

/** useLines reads the newest window of each unread conversation; it reads again when a conversation has a new last message. */
function useLines(rows: Conversation[]): Record<number, Message[]> {
  const [lines, setLines] = useState<Record<number, { key: string; list: Message[] }>>({});
  const key = rows.map((c) => `${c.id}:${c.last?.id ?? 0}:${c.main_unread ?? c.unread}`).join(",");
  useEffect(() => {
    for (const c of rows) {
      const k = `${c.last?.id ?? 0}:${c.main_unread ?? c.unread}`;
      if (lines[c.id]?.key === k || !(c.main_unread ?? c.unread)) continue;
      source.messages(c.id, { limit: WINDOW }).then(
        ({ messages }) => setLines((l) => ({ ...l, [c.id]: { key: k, list: messages } })),
        () => {},
      );
    }
  }, [key]);
  return useMemo(() => Object.fromEntries(Object.entries(lines).map(([id, v]) => [id, v.list])), [lines]);
}

/** useTriage is what Now shows of the unread conversations; Now calls it so the Needs you count can include the mentions. */
export function useTriage(rows: Conversation[], me: string): Triage {
  const lines = useLines(rows);
  return useMemo(() => triage(rows, lines, me), [rows, lines, me]);
}

/** useMarkRead marks conversations read with one toast, and keeps only the buttons of the conversations being marked off meanwhile (owner, conv 324 msg 5900: one shared flag greyed every card). */
function useMarkRead() {
  const { fail } = useNotice();
  const [pending, setPending] = useState<ReadonlySet<number>>(new Set());
  const run = async (ids: number[], said: string) => {
    setPending((p) => new Set([...p, ...ids]));
    try {
      await Promise.all(ids.map(markAllRead));
      toast(said);
    } catch (err) {
      fail(humanError(err));
    } finally {
      setPending((p) => {
        const next = new Set(p);
        for (const id of ids) next.delete(id);
        return next;
      });
    }
  };
  return { pending, run };
}

/** Cards are the rows of Mentions and Replies: the title, the whole message (four lines at most), then Reply and Mark read. */
function Cards({ items, label, current }: { items: Item[]; label: string; current: number }) {
  const { pending, run } = useMarkRead();
  return (
    <ul className="m-0 mb-8 flex list-none flex-col gap-8 p-0" role="list" aria-label={label}>
      {items.map(({ c, line }) => (
        <li key={c.id} className="flex flex-col rounded-[14px] border border-solid border-border bg-raised px-14 pt-4 pb-2" data-id={c.id} aria-current={c.id === current ? "page" : undefined}>
          <a className="flex flex-col gap-2 pt-8 pb-4 text-inherit no-underline" href={`/chats/${c.id}`}>
            <span className="flex items-center gap-8">
              <h2 className="rowtitle min-w-0 flex-auto font-semibold">{titleOf(c)}</h2>
              <time className="when">{ago(c.last_activity_at)}</time>
            </span>
            {/* uline is the hook of the e2e specs that read the line of a card. */}
            <span className="uline line-clamp-4 text-13 leading-[20px] text-muted">
              <b className="font-semibold text-text">{line.author}</b> {line.text}
            </span>
          </a>
          <div className="flex items-center">
            <Button variant="text" size="inline" className="-ml-8" href={`/chats/${c.id}#compose`} onClick={(e) => visit(e, `/chats/${c.id}#compose`)}>
              Reply
            </Button>
            <Button variant="text" size="inline" disabled={pending.has(c.id)} aria-label={`Mark ${titleOf(c)} read`} onClick={() => void run([c.id], "Marked read")}>
              Mark read
            </Button>
          </div>
        </li>
      ))}
    </ul>
  );
}

/** Mentions are the messages that @mention the owner, under the Needs you heading and its asks. */
export const Mentions = memo(function Mentions({ items, current = 0 }: { items: Item[]; current?: number }) {
  return <Cards items={items} label="Mentions of you" current={current} />;
});

/** Replies are the answers to what the owner said, each with its newest message whole. */
export const Replies = memo(function Replies({ items, current = 0 }: { items: Item[]; current?: number }) {
  return (
    <section id="replies" className="block" aria-labelledby="replies-head">
      <p id="replies-head" className="ghdr">Replies to you</p>
      <Cards items={items} label="Replies to you" current={current} />
    </section>
  );
});

/** OtherChats is the news the owner is not in: one line per conversation and one Mark all read for them. */
export const OtherChats = memo(function OtherChats({ rows, current = 0 }: { rows: Quiet[]; current?: number }) {
  const { pending, run } = useMarkRead();
  return (
    <section id="unread" className="block" aria-labelledby="unread-head">
      <p id="unread-head" className="ghdr">Other chats</p>
      <ul className="m-0 mb-8 flex list-none flex-col gap-4 p-0" role="list" aria-label="Other chats">
        {rows.map(({ c, who }) => (
          <li key={c.id} data-id={c.id} aria-current={c.id === current ? "page" : undefined}>
            <a className="flex items-baseline gap-8 py-4 text-inherit no-underline" href={`/chats/${c.id}`}>
              <span className="rowtitle min-w-0 font-semibold">{titleOf(c)}</span>
              <span className="truncate text-13 text-muted">{`${who}, ${c.unread} new`}</span>
            </a>
          </li>
        ))}
      </ul>
      <div className="btns">
        <Button disabled={rows.some(({ c }) => pending.has(c.id))} onClick={() => void run(rows.map(({ c }) => c.id), "Marked all read")}>
          Mark all read
        </Button>
      </div>
    </section>
  );
});
