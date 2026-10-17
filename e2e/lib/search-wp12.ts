import type { DatabaseSync } from "node:sqlite";
import { createConversation, ownerSays } from "./chat.ts";
import type { ServerOptions } from "./fixtures.ts";
import { agentPostWith, idsByHandle, leaseOf, msgWorld, type MsgWorld } from "./messages-wp4.ts";
import { must } from "./owner.ts";

/**
 * The search fixture of specs/features/search.feature (WP12): conversations 41 "Ship search filters" and 52 "Deploy alerts runbook"
 * with messages, asks, files, links and app messages from "devtool" and "docs".
 *
 * ROUTE  GET /api/search?q=<text>&limit=<n>  (owner, or an agent's lease)
 *   -> {results:[{message_id, conversation_id, conversation_title, author:{handle,...}, created_at, kind?:"ask", app?:true,
 *        thread_root_id?, snippet:[{text, hit?:true}]}], conversations:[{id, title, starred?, snippet}], filters:[{token, label}]}
 *   Results are the messages the caller may see, newest first. The text holds words (each matches as the start of a word) and the
 *   filters from:@handle, in:"title", is:ask, is:pinned, is:starred, is:app, has:file, has:link. `convoz search [--json] <text>` is the CLI.
 *
 * Where the fixture needs an action of another work package (an ask, a pin, a star, a file), the row is written to the data file the
 * way that module will write it, and indexed the way the search port indexes a message: the asks, prefs and upload modules do not
 * have their routes in this build. The message rows, links and app messages are real posts.
 */

export interface SearchWorld extends MsgWorld {
  /** Conversation 41 is `conv`; conversation 52 is this one. */
  conv52: number;
  /** The leases of the two agents. */
  devtool: string;
  docs: string;
  /** Ids of the messages the scenarios look at, by what they are. */
  ids: { ask41: number; ask52: number; app41: number; app52: number; file41: number; pinned: number; link41: number; link52: number };
}

type Fx = { server: (o?: ServerOptions) => Promise<ServerHandle>; dataDir: string };
type ServerHandle = Awaited<ReturnType<Fx["server"]>>;

const text = async (w: MsgWorld, lease: string, conv: number, body: string, extra: Record<string, unknown> = {}): Promise<number> =>
  must(await agentPostWith(w.srv, lease, conv, { body, ...extra }), `post "${body}"`, 201).json().id as number;

/** A code app the way an agent posts one (app.v1; its text is the fallback a search finds). */
const appOf = (title: string) => ({ v: 1, type: "code", title, fallback: title, props: { mode: "code", text: title } });

/** Background: a fresh server, owner "drew", machine "box-2" with "devtool" and "docs", and the search fixture. */
export async function searchWorld(o: Fx): Promise<SearchWorld> {
  const base = await msgWorld({ ...o, participants: ["devtool"], agents: ["devtool", "docs"] });
  const conv52 = await createConversation(base.owner, { participants: ["devtool", "docs"], title: "Deploy alerts runbook" });
  const devtool = await leaseOf(base, "devtool");
  const docs = await leaseOf(base, "docs");
  const conv41 = base.conv;

  // conversation 41: messages, a link, an app, a file (devtool)
  await text(base, devtool, conv41, "retry budget is the first thing to deploy behind the flag");
  await text(base, devtool, conv41, "error budget for the filter chips is three attempts");
  const link41 = await text(base, devtool, conv41, "design notes for the filters https://docs.acme.dev/search/filters");
  const app41 = await text(base, devtool, conv41, "Filter chips before and after", { app: appOf("Filter chips before and after") });
  const file41 = await text(base, devtool, conv41, "chart of the retry budget");
  await text(base, devtool, conv41, "latency chart for the error budget");
  const pinned = await text(base, devtool, conv41, "the rollout plan: staging first, prod on Thursday");
  await text(base, devtool, conv41, "rollback if the filters slow the page, the router stays as it is");
  // conversation 52: messages, a link, an app (docs and devtool)
  await text(base, docs, conv52, "deploy alerts runbook: check the error rate first");
  await text(base, devtool, conv52, "deploy error: the alert fired twice, see the runbook");
  const link52 = await text(base, docs, conv52, "runbook https://wiki.acme.dev/runbook/deploy-alerts");
  const app52 = await text(base, docs, conv52, "Alert thresholds", { app: appOf("Alert thresholds") });
  await text(base, docs, conv52, "the alert filters for the runbook are in the dashboard");
  await text(base, docs, conv52, "route the pager through the router");

  // what other modules write: asks, a file, a pin, a star
  const db = base.db();
  const who = idsByHandle(db);
  const ask = (conv: number, asker: string, question: string): number => {
    const at = Date.now();
    const id = Number(
      db
        .prepare("INSERT INTO messages (conversation_id, author_id, kind, format, body, created_at) VALUES (?, ?, 'ask', 'plain', ?, ?)")
        .run(conv, who[asker]!, question, at).lastInsertRowid,
    );
    db.prepare("INSERT INTO asks (message_id, conversation_id, asker_id, question, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").run(id, conv, who[asker]!, question, at, at);
    indexed(db, id, conv, who[asker]!, "ask", question, at);
    return id;
  };
  const ask41 = ask(conv41, "devtool", "Ship the filter chips on Thursday?");
  const ask52 = ask(conv52, "docs", "Page the on-call about the deploy alerts?");
  db.prepare(
    "INSERT INTO uploads (public_id, uploader_id, conversation_id, message_id, kind, state, declared_size, committed_bytes, declared_sha256, mime_sniffed, filename, storage_name, dek_id, file_key_wrapped, created_at, completed_at, bound_at) VALUES (?, ?, ?, ?, 'file', 'complete', 10, 10, ?, 'application/pdf', 'chart.pdf', 'chart-0001', 1, ?, ?, ?, ?)",
  ).run("TESTONLYfile0000000001", who.devtool!, conv41, file41, new Uint8Array(32), new Uint8Array(8), Date.now(), Date.now(), Date.now());
  db.prepare("INSERT INTO pins (identity_id, message_id, created_at) VALUES (?, ?, ?)").run(who.drew!, pinned, Date.now());
  db.prepare("INSERT INTO conversation_prefs (identity_id, conversation_id, starred_at, updated_at) VALUES (?, ?, ?, ?)").run(who.drew!, conv52, Date.now(), Date.now());
  db.close();

  return { ...base, conv52, devtool, docs, ids: { ask41, ask52, app41, app52, file41, pinned, link41, link52 } };
}

/** What the search port writes for a message: its entry and its words. */
function indexed(db: DatabaseSync, id: number, conv: number, author: number, kind: string, words: string, at: number): void {
  // A build without the search module has no index to write (a scenario then fails where it asks for the search, not here).
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'search_entries'").get()) return;
  db.prepare("INSERT INTO search_entries (message_id, conversation_id, author_id, kind, is_app, has_link, created_at) VALUES (?, ?, ?, ?, 0, 0, ?)").run(id, conv, author, kind, at);
  db.prepare("INSERT INTO messages_fts (rowid, text) VALUES (?, ?)").run(id, words);
}

// ---- asking -----------------------------------------------------------------------------------------------------

export interface Found {
  message_id: number;
  conversation_id: number;
  conversation_title: string;
  author: { handle: string; kind: string };
  created_at: number;
  kind?: string;
  app?: boolean;
  thread_root_id?: number;
  snippet: { text: string; hit?: boolean }[];
}

export interface Answer {
  results: Found[];
  conversations: { id: number; title: string; starred?: boolean; snippet: { text: string; hit?: boolean }[] }[];
  filters: { token: string; label: string }[];
}

/** `GET /api/search?q=` as the owner: the answer. */
export async function searchAs(w: Pick<SearchWorld, "owner">, q: string, limit?: number): Promise<Answer> {
  const res = await w.owner.client.get(`/api/search?q=${encodeURIComponent(q)}${limit ? `&limit=${limit}` : ""}`);
  return must(res, `search "${q}"`).json() as Answer;
}

/** The words of a result, as its snippet shows them. */
export const wordsOf = (f: Found): string => f.snippet.map((p) => p.text).join("");

export { ownerSays };
