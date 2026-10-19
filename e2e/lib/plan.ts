import type { BrowserContext, Locator, Page } from "@playwright/test";
import { chatWorld, convoz, createConversation, startSession, type AgentSession, type World } from "./chat.ts";
import type { ServerHandle, ServerOptions } from "./fixtures.ts";
import { send, type Res } from "./http.ts";
import { bearer, signInBrowser } from "./machines.ts";
import { must } from "./owner.ts";
import type { RunResult } from "./run.ts";
import { messageLog, recordStreams } from "./chat-ui.ts";

/**
 * Helpers of the plan scenarios (tests/plan.spec.ts, tests/plan.contracts.spec.ts). The contract they rely on:
 *   PUT /api/conversations/:id/plan   (lease, scope status) {doing?, step?: "2/3", eta?: "30m"|"HH:MM", utc_offset?, next?: [], waiting?: [], done?: []}
 *                                     -> 200 Plan {conversation_id, identity_id, handle, doing, doing_since?, step?: {at, of}, eta?, next: [],
 *                                        waiting: [{text, since}], done: [{text, at}] (newest first), updated_at, due_at?}
 *   GET /api/plans[?conversation=C]   (a person) -> {now, plans: [Plan], agents: [{identity_id, handle, state, doing, online, last_seen_at?,
 *                                        liveness: ok|not_responding|logged_out}], asks: [OpenAsk], attention: [{conversation_id, state, handle, text, eta?,
 *                                        last_seen_at?}], next_change_at?}
 *   attention.state is one of waiting, blocked, not_responding, logged_out, late, stale, working, next, done.
 *   `convoz plan <conv> [--doing D] [--step N/M] [--eta 30m|HH:MM] [--next N]... [--waiting W]... [--done D]...` prints the plan.
 *   Inbox reason "status_due": the agent is asked to update its plan (conversation set, message is a system text).
 * Page contract: the line under a conversation's title is a button whose name starts with the line's text ("Working · …"); it carries a
 * dot with data-tone green|amber|red|grey. The details panel has the regions "Waiting on you · N" and "Agents · N" (a list
 * "Agents" of one card per agent; the owner is the row "You" under "Conversation") before "Conversation". A Conversations row carries an icon (role img, named by the state:
 * "Working", "Waiting on you", "Blocked", "Late", "Not responding") next to its unread count.
 */

export interface PlanWorld {
  w: World;
  conv: number;
  dev: AgentSession;
  docs: AgentSession;
}

/** Background: owner "drew", machine "box-2" with "devtool" and "docs", both in conversation "Ship search filters", each with a session. */
export async function planWorld(server: (o?: ServerOptions) => Promise<ServerHandle>, o: { docsIn?: boolean; env?: Record<string, string> } = {}): Promise<PlanWorld> {
  const w = await chatWorld(server, { agents: ["devtool", "docs"], ...(o.env ? { env: o.env } : {}) });
  const conv = await createConversation(w.owner, { title: "Ship search filters", participants: o.docsIn === false ? ["devtool"] : ["devtool", "docs"] });
  const dev = await startSession(w.box, "devtool", "plan-dev");
  const docs = await startSession(w.box, "docs", "plan-docs");
  return { w, conv, dev, docs };
}

/** The same world, with the owner's browser signed in (all API step-ups done before, as uiWorld does). */
export async function planUi(fx: { server: (o?: ServerOptions) => Promise<ServerHandle>; page: Page; context: BrowserContext }, o: { docsIn?: boolean; env?: Record<string, string> } = {}): Promise<PlanWorld> {
  const p = await planWorld(fx.server, o);
  await recordStreams(fx.context);
  await signInBrowser(p.w.srv, p.w.owner, fx.page, fx.context);
  return p;
}

/** `convoz plan <conv> ...` as one agent. */
export function plan(p: PlanWorld, who: AgentSession, argv: string[], conv = p.conv): Promise<RunResult> {
  return convoz(p.w.box, who.sid, ["plan", String(conv), ...argv]);
}

/** `convoz plan` that must succeed. */
export async function mustPlan(p: PlanWorld, who: AgentSession, argv: string[], conv = p.conv): Promise<RunResult> {
  const res = await plan(p, who, argv, conv);
  if (res.code !== 0) throw new Error(`convoz plan ${argv.join(" ")}: exit ${res.code}\n${res.stderr}`);
  return res;
}

/** `PUT /api/conversations/:id/plan` with a lease. */
export function putPlan(srv: ServerHandle, leaseToken: string, conv: number, body: Record<string, unknown>): Promise<Res> {
  return send(srv.target, "PUT", `/api/conversations/${conv}/plan`, { json: body, ...bearer(leaseToken) });
}

export interface Plan {
  conversation_id: number;
  identity_id: number;
  handle: string;
  doing: string;
  doing_since?: number;
  step?: { at: number; of: number };
  eta?: number;
  next: string[];
  waiting: { text: string; since: number }[];
  done: { text: string; at: number }[];
  updated_at: number;
  due_at?: number;
}

export interface Board {
  now: number;
  plans: Plan[];
  agents: { identity_id: number; handle: string; state: string; liveness: string; last_seen_at?: number; online: boolean }[];
  attention: { conversation_id: number; state: string; handle: string; text: string; eta?: number }[];
  next_change_at?: number;
}

/** `GET /api/plans[?conversation=C]` as the owner. */
export async function board(p: PlanWorld, conv?: number): Promise<Board> {
  return must(await p.w.owner.client.get(`/api/plans${conv ? `?conversation=${conv}` : ""}`), "read the plans").json() as Board;
}

/** The plan of one agent in the conversation, or undefined. */
export async function planOf(p: PlanWorld, handle: string, conv = p.conv): Promise<Plan | undefined> {
  return (await board(p, conv)).plans.find((x) => x.handle === handle && x.conversation_id === conv);
}

/** The attention state of one conversation ("" when there is nothing to show). */
export async function attentionOf(p: PlanWorld, conv = p.conv): Promise<string> {
  return (await board(p, conv)).attention.find((a) => a.conversation_id === conv)?.state ?? "";
}

// ---- the page --------------------------------------------------------------------------------------------------------------

/** The line under the title of an open conversation. */
export const planLine = (page: Page): Locator => page.locator("#planline");
/** The status icon of a Conversations row (msg 382), next to its unread count. */
export const rowIcon = (row: Locator): Locator => row.locator(".planicon");
/** A quiet system line of the open conversation (a note in the message log). */
export const quietLine = (page: Page, text: string | RegExp): Locator => messageLog(page).getByRole("note").filter({ hasText: text });
/** The details panel. */
export const detailsPanel = (page: Page): Locator => page.getByRole("complementary", { name: /^Details for / });

/** The clock time the page shows for an instant, in the browser's own time zone ("11:30"). */
export const clockIn = (page: Page, ms: number): Promise<string> =>
  page.evaluate((t) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }), ms);
