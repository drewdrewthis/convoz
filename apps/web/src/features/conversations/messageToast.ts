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
  const first = m.body.split("\n").find((l) => l.trim())?.trim() ?? "";
  const text = first.length > CUT ? `${first.slice(0, CUT - 1)}…` : first;
  return `@${m.author.handle}${at.title ? ` in ${at.title}` : ""}: ${text}`;
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
