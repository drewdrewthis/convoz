import type { MessageCreatedFrame } from "@convoz/api-client";

/** How much of a message's first line a toast shows. */
const CUT = 60;

/**
 * messageLine is the toast line for a new message, or null when it is not news to the owner: their own message, one in the
 * conversation open on screen or in a muted one (mute means quiet), a system line, or an ask (the Now arrival toast tells of an ask; one toast, not two). Owner,
 * 2026-10-30 (conv 179 msg 14167): "can I get a toast for every message?"
 */
export function messageLine(m: MessageCreatedFrame, at: { me: string; open: number | null; title?: string | null; muted?: boolean }): string | null {
  if (m.author.handle === at.me || m.conversation_id === at.open || at.muted || m.kind === "system" || m.kind === "ask" || m.author.kind === "system") return null;
  const first = withoutTitle(shortenUrls(m.body.split("\n").find((l) => l.trim())?.trim() ?? ""), at.title);
  const text = first.length > CUT ? `${first.slice(0, CUT - 1)}…` : first;
  return `${whoWhere(m, at.title)}: ${text}`;
}

/** whoWhere is "@author in chat", the part of a toast that says who spoke and where. */
export const whoWhere = (m: Pick<MessageCreatedFrame, "author">, title?: string | null): string => `@${m.author.handle}${title ? ` in ${title}` : ""}`;

/** shortenUrls trades a link for what the owner reads at a glance: "PR 9190" for a github pull, the host for any other. */
export function shortenUrls(text: string): string {
  return text.replace(/https?:\/\/[^\s<>)]+/g, (raw) => {
    const url = raw.replace(/[.,;:!?]+$/, "");
    const tail = raw.slice(url.length);
    try {
      const u = new URL(url);
      const pr = /^\/[^/]+\/[^/]+\/pull\/(\d+)/.exec(u.pathname);
      return (u.hostname === "github.com" && pr ? `PR ${pr[1]}` : u.hostname) + tail;
    } catch {
      return raw;
    }
  });
}

/** withoutTitle drops a leading "Title:" (or its first part before a colon) the toast already says after "in". */
function withoutTitle(text: string, title?: string | null): string {
  for (const t of title ? [title, title.split(":")[0]!.trim()] : []) {
    if (t && text.toLowerCase().startsWith(`${t.toLowerCase()}:`)) return text.slice(t.length + 1).trim() || text;
  }
  return text;
}

/** newMessagesLine is the one toast for the news of a moment: the line itself for one message, else a count and the latest author and chat. */
export function newMessagesLine(news: { line: string; who: string }[]): string {
  return news.length === 1 ? news[0]!.line : `${news.length} new messages · latest: ${news[news.length - 1]!.who}`;
}

/** messageHref is the app path that opens the message in its conversation (the same link "Copy link" gives). */
export const messageHref = (m: Pick<MessageCreatedFrame, "id" | "conversation_id">): string => `/chats/${m.conversation_id}#m${m.id}`;

/**
 * batch collects what `add` gets for `ms` from the first item, then hands it all to `flush` at once. The window does not restart
 * on each item, so a steady stream is still handed over every `ms`.
 */
export function batch<T>(ms: number, flush: (items: T[]) => void): (item: T) => void {
  let items: T[] = [];
  return (item) => {
    items.push(item);
    if (items.length > 1) return;
    setTimeout(() => {
      const out = items;
      items = [];
      flush(out);
    }, ms);
  };
}
