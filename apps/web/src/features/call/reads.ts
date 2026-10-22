// The triage call's reads beyond Now: search, one conversation, the list. Every answer is cut down so a whole call of them fits the
// model's context (tools.ts runs them; the server's triageReads declares them).
import { call, client } from "../../shared/api.ts";

/** The most characters of one message's words that go to the model. */
export const MOST_TEXT = 300;
const MOST_HITS = 10;
const MOST_TITLE_HITS = 5;
const MOST_LISTED = 25;
/** read_conversation's default and most messages, and the threads whose replies it reads (the newest ones). */
export const READ_DEFAULT = 30;
export const READ_MOST = 50;
const MOST_THREADS = 5;
const MOST_REPLIES = 5;

const at = (ms: number): string => new Date(ms).toISOString().slice(0, 16) + "Z";
const cut = (text: string): string => {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > MOST_TEXT ? t.slice(0, MOST_TEXT - 1) + "…" : t;
};

/** search_messages: the best message hits of the server's search, newest first, and the conversations whose title the words name. */
export async function searchMessages(query: string): Promise<Record<string, unknown>> {
  const found = await call(client.GET("/api/search", { params: { query: { q: query, limit: MOST_HITS } } }));
  const hits = found.results.slice(0, MOST_HITS).map((r) => ({
    conversation: r.conversation_title,
    conversation_id: r.conversation_id,
    author: r.author.handle,
    at: at(r.created_at),
    text: cut(r.snippet.map((p) => p.text).join("")),
    message_id: r.message_id,
    ...(r.thread_root_id ? { in_thread_of: r.thread_root_id } : {}),
  }));
  const conversations = found.conversations.slice(0, MOST_TITLE_HITS).map((c) => ({ id: c.id, title: c.title }));
  return hits.length || conversations.length ? { hits, conversations } : { hits, conversations, note: "nothing found" };
}

/** list_conversations: the owner's open conversations (not the trash), newest activity first. */
export async function listConversations(): Promise<Record<string, unknown>> {
  const { conversations } = await call(client.GET("/api/conversations"));
  return {
    conversations: conversations.slice(0, MOST_LISTED).map((c) => ({
      id: c.id,
      title: c.title ?? "",
      unread: c.unread,
      last_activity: at(c.last_activity_at),
    })),
    total: conversations.length,
  };
}

/** Which conversation read_conversation (or a write, writes.ts) names: the id, or the newest-active one whose title holds the words; others that match too. */
export async function pick(id: number | undefined, title: string): Promise<{ id: number; title: string; also: string[] } | null> {
  const { conversations } = await call(client.GET("/api/conversations"));
  if (id) {
    const c = conversations.find((x) => x.id === id);
    return c ? { id, title: c.title ?? "", also: [] } : null;
  }
  const words = title.toLowerCase();
  const matches = conversations.filter((c) => (c.title ?? "").toLowerCase().includes(words));
  if (!matches.length) return null;
  return { id: matches[0]!.id, title: matches[0]!.title ?? "", also: matches.slice(1, MOST_TITLE_HITS).map((c) => c.title ?? "") };
}

/**
 * read_conversation: the newest `limit` messages of one conversation, oldest first; the newest few threads among them carry up to
 * MOST_REPLIES replies each. A deleted message and a system line say nothing, so they are left out.
 */
export async function readConversation(id: number | undefined, title: string, limit: number): Promise<Record<string, unknown>> {
  const found = await pick(id, title);
  if (!found) return { error: "no such conversation" };
  const { messages } = await call(client.GET("/api/conversations/{id}/messages", { params: { path: { id: found.id }, query: { limit } } }));
  const shown = messages.slice(-limit).filter((m) => !m.deleted && m.kind !== "system");
  const roots = new Set(shown.filter((m) => (m.reply_count ?? 0) > 0).slice(-MOST_THREADS).map((m) => m.id));
  const out = await Promise.all(
    shown.map(async (m) => {
      const line = { id: m.id, author: m.author.handle, at: at(m.created_at), text: cut(m.body ?? "") };
      if (!roots.has(m.id)) return line;
      const thread = await call(client.GET("/api/messages/{id}/replies", { params: { path: { id: m.id } } }));
      const replies = thread.messages.filter((r) => !r.deleted).slice(-MOST_REPLIES).map((r) => ({ author: r.author.handle, at: at(r.created_at), text: cut(r.body ?? "") }));
      return { ...line, replies, reply_count: m.reply_count };
    }),
  );
  return { conversation: { id: found.id, title: found.title }, messages: out, ...(found.also.length ? { other_matches: found.also } : {}) };
}
