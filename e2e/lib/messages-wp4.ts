import type { DatabaseSync } from "node:sqlite";
import { agentPost, chatWorld, createConversation, ownerPost } from "./chat.ts";
import type { CliMachine } from "./cli.ts";
import type { ServerHandle, ServerOptions } from "./fixtures.ts";
import type { Res } from "./http.ts";
import { send } from "./http.ts";
import { allow, bearer, clientId, createAgents, mintSession, plainDb, stepped, type LoggedIn } from "./machines.ts";
import type { Owner } from "./owner.ts";
import { must } from "./owner.ts";

/**
 * Helpers for the message scenarios of WP4 (tests/messages-types.wp4.spec.ts, security.wp4.spec.ts, ops.wp4.spec.ts).
 * The routes they call are the contract block at the top of messages-types.wp4.spec.ts.
 */

type Fx = { server: (o?: ServerOptions) => Promise<ServerHandle>; dataDir: string };

export interface MsgWorld {
  srv: ServerHandle;
  owner: Owner;
  box2: LoggedIn;
  /** The `convoz` CLI of machine "box-2". */
  box: CliMachine;
  dataDir: string;
  /** Conversation 41 "Ship search filters" (the Background): the owner and `participants`. */
  conv: number;
  /** A handle to the live (plain) data file of the encryption-off build. Close it when done. */
  db(): DatabaseSync;
}

/**
 * Background: a fresh Convoz server (the encryption-off test build, so a scenario can look into the data file) with owner "drew",
 * machine "box-2" logged in with allow-list "devtool" and "docs" (and `more`), and "devtool" an active participant of
 * conversation 41 "Ship search filters".
 */
export async function msgWorld(
  o: Fx & { participants?: string[]; agents?: string[]; title?: string; env?: Record<string, string> },
): Promise<MsgWorld> {
  const agents = o.agents ?? ["devtool", "docs"];
  const w = await chatWorld(o.server, { agents, allowed: allow(...agents), env: { CONVOZ_TEST_PLAINTEXT: "1", ...(o.env ?? {}) } });
  const conv = await createConversation(w.owner, { participants: o.participants ?? ["devtool"], title: o.title ?? "Ship search filters" });
  return {
    srv: w.srv,
    owner: w.owner,
    box2: w.box2,
    box: w.box,
    dataDir: o.dataDir,
    conv,
    db: () => plainDb(o.dataDir),
  };
}

/** A lease of `handle` on box-2 with its own session label. */
export async function leaseOf(w: MsgWorld, handle: string, label = `claude-${handle}`): Promise<string> {
  return must(await mintSession(w.srv, w.box2.key, { as: handle, label }), `mint ${handle}`, 201).json().lease as string;
}

/** More agents than the Background has (for the scenarios with many identities). */
export async function moreAgents(w: MsgWorld, ...handles: string[]): Promise<void> {
  await createAgents(w.owner, ...handles);
}

// ---- messages ------------------------------------------------------------------------------------------

export interface WireMessage {
  id: number;
  kind?: string;
  author: { handle: string; display_name: string; kind: string };
  body: string;
  format: string;
  created_at: number;
  thread_root_id?: number;
  broadcast?: boolean;
  reply_count?: number;
  edited_at?: number;
  deleted?: boolean;
  purged?: boolean;
  system?: { t: string; identity?: { handle: string; display_name: string }; by?: { handle: string; display_name: string }; [k: string]: unknown };
  text?: string;
  uploads?: { id: string; kind: string; name: string; size: number; mime: string; inline: boolean; duration_ms?: number; transcript?: { state: string; text?: string } }[];
  session_label?: string;
  machine?: string;
}

/** The newest page of a conversation as the owner reads it, oldest first, every field the server sends. */
export async function pageOf(owner: Owner, conv: number, query = ""): Promise<WireMessage[]> {
  return must(await owner.client.get(`/api/conversations/${conv}/messages${query ? `?${query}` : ""}`), `read conversation ${conv}`).json().messages;
}

/** The message with this body in the newest page. */
export async function byBody(owner: Owner, conv: number, body: string): Promise<WireMessage> {
  const found = (await pageOf(owner, conv, "limit=100")).find((m) => m.body === body);
  if (!found) throw new Error(`no message with body ${JSON.stringify(body)} in conversation ${conv}`);
  return found;
}

/** A post with any body fields (a reply, a broadcast, an app, attachments) as the owner. */
export function ownerPostWith(owner: Owner, conv: number, fields: Record<string, unknown>): Promise<Res> {
  return owner.client.post(`/api/conversations/${conv}/messages`, { client_id: clientId(), ...fields });
}

/** A post with any body fields as an agent. */
export function agentPostWith(srv: ServerHandle, lease: string, conv: number, fields: Record<string, unknown>): Promise<Res> {
  return send(srv.target, "POST", `/api/conversations/${conv}/messages`, { json: { client_id: clientId(), needs_you: false, ...fields }, ...bearer(lease) });
}

/** `PATCH /api/messages/:id` as the owner. The raw answer. */
export function ownerEdits(owner: Owner, id: number, fields: Record<string, unknown>): Promise<Res> {
  return owner.client.request("PATCH", `/api/messages/${id}`, { csrf: true, json: { client_id: clientId(), ...fields } });
}

/** `PATCH /api/messages/:id` with a lease. The raw answer. */
export function agentEdits(srv: ServerHandle, lease: string, id: number, fields: Record<string, unknown>): Promise<Res> {
  return send(srv.target, "PATCH", `/api/messages/${id}`, { json: { client_id: clientId(), ...fields }, ...bearer(lease) });
}

/** `DELETE /api/messages/:id` as the owner. The raw answer. */
export function ownerDeletes(owner: Owner, id: number): Promise<Res> {
  return owner.client.del(`/api/messages/${id}`);
}

/** `DELETE /api/messages/:id` with a lease. The raw answer. */
export function agentDeletes(srv: ServerHandle, lease: string, id: number): Promise<Res> {
  return send(srv.target, "DELETE", `/api/messages/${id}`, bearer(lease));
}

/** `POST /api/messages/:id/purge` as the owner, with a fresh step-up for it. The raw answer. */
export function ownerPurges(owner: Owner, id: number): Promise<Res> {
  return stepped(owner, "POST", `/api/messages/${id}/purge`, {}, "message.purge", id);
}

/** Post `n` messages in a row with these leases, taking turns. Every one must be stored. */
export async function agentsPost(w: MsgWorld, leases: string[], conv: number, n: number, prefix = "m"): Promise<void> {
  for (let i = 0; i < n; i++) {
    const res = await agentPost(w.srv, leases[i % leases.length]!, conv, `${prefix}-${i + 1}`);
    if (res.status !== 201) throw new Error(`post ${i + 1} of ${n}: HTTP ${res.status} ${res.text}`);
  }
}

// ---- the other modules' actions, by their test hooks --------------------------------------------------------

/**
 * A system line, written the way the action that causes it does it. The actions of adding someone and renaming a conversation
 * belong to the conversation work package, so until they land the line is written by this hook (testhooks build).
 */
export async function systemLine(w: MsgWorld, conv: number, line: Record<string, unknown>): Promise<number> {
  return must(await send(w.srv.target, "POST", "/__test/system-line", { json: { conversation: conv, ...line } }), "write a system line").json().id as number;
}

/** Spend the daily message budget of a machine: `count` messages posted today across its identities. */
export async function spendMachineBudget(w: MsgWorld, machine: number, count: number): Promise<void> {
  must(await send(w.srv.target, "POST", "/__test/message-budget", { json: { machine, count } }), "spend the machine budget");
}

// ---- the data file --------------------------------------------------------------------------------------------

/** Every text a table holds, as one string per row: what a "scan of every table" reads. Virtual tables are skipped (their shadow tables are real). */
export function everyRow(db: DatabaseSync): string[] {
  const out: string[] = [];
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND sql NOT LIKE 'CREATE VIRTUAL%'").all() as { name: string }[];
  for (const { name } of tables) {
    // BigInts: the index's shadow tables hold ids beyond 2^53
    const rows = db.prepare(`SELECT * FROM "${name}"`);
    rows.setReadBigInts(true);
    for (const row of rows.all()) {
      out.push(`${name}: ${JSON.stringify(row, (_k, v) => (v instanceof Uint8Array ? Buffer.from(v).toString("latin1") : typeof v === "bigint" ? v.toString() : v))}`);
    }
  }
  return out;
}

/** How many rows of every table, and how many times in total, contain `needle`. */
export function rowsWith(db: DatabaseSync, needle: string): string[] {
  return everyRow(db).filter((r) => r.includes(needle));
}

/** The ids of the identities by handle. */
export function idsByHandle(db: DatabaseSync): Record<string, number> {
  const rows = db.prepare("SELECT id, handle FROM identities").all() as { id: number; handle: string }[];
  return Object.fromEntries(rows.map((r) => [r.handle, Number(r.id)]));
}

/** The types of the events after `seq`, oldest first. */
export function eventTypesAfter(db: DatabaseSync, seq: number): string[] {
  return (db.prepare("SELECT type FROM events WHERE seq > ? ORDER BY seq").all(seq) as { type: string }[]).map((r) => r.type);
}

export function maxEventSeq(db: DatabaseSync): number {
  return Number((db.prepare("SELECT COALESCE(MAX(seq), 0) AS n FROM events").get() as { n: number }).n);
}

export { agentPost, ownerPost };
