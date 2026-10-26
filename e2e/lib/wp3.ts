import { DatabaseSync } from "node:sqlite";
import type { BrowserContext, Locator, Page } from "@playwright/test";
import { allow, bearer, clientId, createAgents, DEFAULT_SCOPES, loginMachine, plainDb, signInBrowser, type LoggedIn } from "./machines.ts";
import { installedMachine, type CliMachine } from "./cli.ts";
import { agentPost, startSession, chatWorld } from "./chat.ts";
import { send, type Res } from "./http.ts";
import type { ServerHandle, ServerOptions } from "./fixtures.ts";
import { bootstrapOwner, must, type Owner } from "./owner.ts";

/**
 * Helpers for the WP3 scenarios: conversations, participants and trash. The routes they call are
 * POST|GET|PATCH|DELETE /api/conversations..., POST .../participants (+ /:iid/approve|decline, DELETE /:iid), POST .../leave
 * (design §13). A conversation view carries `participants` (active), `pending`
 * (waiting adds) and, in the trash, `deleted_at` and `purges_at`.
 */

/** `GET /api/identities`: handle -> identity id. */
export async function idsOf(owner: Owner): Promise<Record<string, number>> {
  const list = must(await owner.client.get("/api/identities"), "list identities").json().identities as { id: number; handle: string }[];
  return Object.fromEntries(list.map((p) => [p.handle, p.id]));
}

export interface PersonRow {
  id?: number;
  handle: string;
  kind: string;
}

export interface ConversationView {
  id: number;
  title: string | null;
  participants: PersonRow[];
  pending?: { person: PersonRow; requested_by?: PersonRow }[];
  started_by?: PersonRow;
  link_url?: string;
  deleted_at?: number;
  purges_at?: number;
  unread: number;
}

/** `GET /api/conversations/:id` as the owner. */
export async function viewOf(owner: Owner, conv: number): Promise<ConversationView> {
  return must(await owner.client.get(`/api/conversations/${conv}`), `view of conversation ${conv}`).json().conversation as ConversationView;
}

/** The handles of the active participants, in order. */
export const handlesOf = (v: ConversationView): string[] => v.participants.map((p) => p.handle);

/** `POST /api/conversations/:id/participants` as the owner. */
export function ownerAdds(owner: Owner, conv: number, identityId: number, history: "since_now" | "full" = "since_now"): Promise<Res> {
  return owner.client.post(`/api/conversations/${conv}/participants`, { identity_id: identityId, history });
}

/** `DELETE /api/conversations/:id/participants/:iid` as the owner. */
export function ownerRemoves(owner: Owner, conv: number, identityId: number): Promise<Res> {
  return owner.client.del(`/api/conversations/${conv}/participants/${identityId}`);
}

/** `DELETE /api/conversations/:id` as the owner: to the trash. */
export function ownerDeletes(owner: Owner, conv: number): Promise<Res> {
  return owner.client.del(`/api/conversations/${conv}`);
}

/** The trash: `GET /api/conversations?deleted=1` as the owner. */
export async function trashOf(owner: Owner): Promise<ConversationView[]> {
  return must(await owner.client.get("/api/conversations?deleted=1"), "list the trash").json().conversations as ConversationView[];
}

/** An agent over HTTP: `POST /api/conversations` with a lease. The raw answer. */
export function agentCreates(srv: ServerHandle, leaseToken: string, o: { title?: string; participants?: string[] }): Promise<Res> {
  return send(srv.target, "POST", "/api/conversations", { json: { client_id: clientId(), ...o }, ...bearer(leaseToken) });
}

/** An agent over HTTP calls a conversation route with its lease. */
export function asAgent(srv: ServerHandle, leaseToken: string, method: string, path: string, json?: unknown): Promise<Res> {
  return send(srv.target, method, path, { ...(json !== undefined ? { json } : {}), ...bearer(leaseToken) });
}

/** A second machine, logged in with the default scopes (or any scopes) and an installed CLI. */
export async function machineWith(
  srv: ServerHandle,
  owner: Owner,
  name: string,
  handles: string[],
  scopes: string[] = DEFAULT_SCOPES,
): Promise<{ login: LoggedIn; box: CliMachine }> {
  const login = await loginMachine(srv, owner, name, allow(...handles), { scopes });
  return { login, box: await installedMachine(srv.origin, name, login.key) };
}

export { startSession, agentPost, chatWorld };

/** What `world` gives back. */
export type World = Awaited<ReturnType<typeof chatWorld>>;

/**
 * The Background of the WP3 scenarios: a fresh server with owner "drew" signed in, the agents, and machine "box-2" logged in with
 * an allow-list of them. With `plaintext` the data file is the encryption-off build's,
 * so a scenario can seed rows the API has no route for.
 */
export async function world(
  server: (o?: ServerOptions) => Promise<ServerHandle>,
  o: { agents?: string[]; plaintext?: boolean } = {},
): Promise<World> {
  const agents = o.agents ?? ["devtool", "docs", "release-bot"];
  const srv = await server({ host: "localhost", adminSocket: true, env: { CONVOZ_TEST_POLL_MS: "250", ...(o.plaintext ? { CONVOZ_TEST_PLAINTEXT: "1" } : {}) } });
  const owner = await bootstrapOwner(srv);
  await createAgents(owner, ...agents);
  const box2 = await loginMachine(srv, owner, "box-2", allow(...agents));
  const box = await installedMachine(srv.origin, "box-2", box2.key);
  return { srv, owner, box2, box };
}

/** Seed rows the API has no route for yet (thread replies, asks), straight into the data file of the encryption-off build. */
export function seedDb<T>(dataDir: string, fn: (db: DatabaseSync) => T): T {
  const db = plainDb(dataDir);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

/** A reply in a thread: a message with a root, written by `author` (identity id). Returns its id. */
export function seedReply(dataDir: string, conv: number, root: number, author: number, body: string): number {
  return seedDb(dataDir, (db) => {
    const r = db
      .prepare("INSERT INTO messages (conversation_id, author_id, kind, body, thread_root_id, created_at) VALUES (?, ?, 'text', ?, ?, ?)")
      .run(conv, author, body, root, Date.now());
    return Number(r.lastInsertRowid);
  });
}

/** An ask by `agent` in `conv`, open or dismissed. Returns the message id. */
export function seedAsk(dataDir: string, conv: number, agent: number, owner: number, question: string, state: "open" | "dismissed"): number {
  return seedDb(dataDir, (db) => {
    const now = Date.now();
    const m = db
      .prepare("INSERT INTO messages (conversation_id, author_id, kind, body, created_at) VALUES (?, ?, 'ask', ?, ?)")
      .run(conv, agent, question, now);
    const id = Number(m.lastInsertRowid);
    db.prepare("INSERT INTO asks (message_id, conversation_id, asker_id, question, sealed, state, resolved_by, resolved_at, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?)").run(
      id,
      conv,
      agent,
      question,
      state,
      state === "dismissed" ? owner : null,
      state === "dismissed" ? now : null,
      now,
      now,
    );
    if (state === "open") db.prepare("UPDATE conversations SET open_ask_count = open_ask_count + 1 WHERE id = ?").run(conv);
    return id;
  });
}

/** The state an ask row holds. */
export function askState(dataDir: string, id: number): { state: string; close_reason: string | null } {
  return seedDb(dataDir, (db) => db.prepare("SELECT state, close_reason FROM asks WHERE message_id = ?").get(id) as { state: string; close_reason: string | null });
}

/** Messages of one conversation as the owner sees them, oldest first (system lines included). */
export async function linesOf(owner: Owner, conv: number): Promise<{ id: number; body: string; author: PersonRow }[]> {
  return must(await owner.client.get(`/api/conversations/${conv}/messages?limit=100`), `read conversation ${conv}`).json().messages;
}

/** The unread count of one conversation in the list of an agent (a lease). */
export async function unreadFor(srv: ServerHandle, leaseToken: string, conv: number): Promise<number | undefined> {
  const list = must(await asAgent(srv, leaseToken, "GET", "/api/conversations"), "agent list").json().conversations as { id: number; unread: number }[];
  return list.find((c) => c.id === conv)?.unread;
}

// ---- the owner's browser ----------------------------------------------------------------------------------


/**
 * `world`, with a live session for each handle in `live` and the owner's browser signed in. All API step-ups happen before the
 * browser takes the passkey (its signature counter continues from there).
 */
export async function browserWorld(
  fx: { server: (o?: ServerOptions) => Promise<ServerHandle>; page: Page; context: BrowserContext },
  o: { agents?: string[]; live?: string[]; plaintext?: boolean; beforeSignIn?: (w: World) => Promise<void> } = {},
): Promise<World & { sessions: Record<string, Awaited<ReturnType<typeof startSession>>> }> {
  const w = await world(fx.server, o);
  const sessions: Record<string, Awaited<ReturnType<typeof startSession>>> = {};
  for (const h of o.live ?? []) sessions[h] = await startSession(w.box, h, `ui-${h}`);
  await o.beforeSignIn?.(w);
  await signInBrowser(w.srv, w.owner, fx.page, fx.context);
  return { ...w, sessions };
}

/** Open a conversation's page and wait until it has loaded. */
export async function openChat(page: Page, srv: ServerHandle, conv: number, title?: string): Promise<void> {
  await page.goto(`${srv.origin}/chats/${conv}`);
  if (title) await page.getByRole("heading", { name: title, exact: true, level: 1 }).waitFor();
}

/** The details panel of the open conversation, opened with the key I. */
export const detailsPanel = (page: Page): Locator => page.getByRole("complementary", { name: /^Details for / });

/** Press I on the page (no text box has focus) and wait for the details. */
export async function showDetails(page: Page): Promise<Locator> {
  await page.getByRole("button", { name: "Show details" }).waitFor();
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur()); // typing in the message box would not press the key
  await page.keyboard.press("i");
  const panel = detailsPanel(page);
  await panel.waitFor();
  return panel;
}

/** The conversation list: rows by title, in order. */
export const rowsOnList = (page: Page): Locator => page.getByRole("list", { name: "Conversations" }).getByRole("listitem");
