import type { Locator, Page } from "@playwright/test";
import type { ServerHandle, ServerOptions } from "./fixtures.ts";
import { createConversation, startSession } from "./chat.ts";
import { send, type Res } from "./http.ts";
import { bearer, clientId, plainDb } from "./machines.ts";
import { must, type Owner } from "./owner.ts";
import { expect } from "./scenario.ts";
import { world, type World } from "./wp3.ts";

/**
 * Helpers of the ask and Now scenarios (asks.wp8.spec.ts, now.wp8.spec.ts). The routes are in packages/contracts/paths/ask.yaml:
 *   POST /api/asks (lease, `ask` scope)  {conversation_id, thread_root_id?, client_id, question, recommended:{label,why}, alternatives:[{label,why}], owners_call:{kind,reason}, urgent?}
 *   GET  /api/asks/:id                   {ask}           the ask with its options, answer and history
 *   POST /api/asks/:id/{answer,dismiss,undismiss}  (owner)   answer {choice: recommended | alternative(+index 1..4) | custom(+text), if_version?, client_id?}
 *   POST /api/asks/:id/withdraw          (asker's lease)
 *   PUT|DELETE /api/asks/:id/snooze      (owner)   {preset: "1h" | "tonight" | "tomorrow", tz?} or {until}
 *   GET  /api/now                        {now, poll_ms, badge, asks, replied, snoozed, answered_today, pending_adds, machine_requests}
 * A 409 carries `{error:{code,message}, ask}`. An ask is `{id, conversation_id, asker, question, urgent, state, close_reason?, options[{label,why}],
 * chosen?{kind,index?,text?}, answer?, owners_call?{kind: one-way|taste|values|scope, reason},  resolved_by?, acked_at?, version, history[], snoozed_until?}`; the first option is the recommended one.
 */

export const QUESTION = "Merge #415 on its own?";

/** What the CLI, the MCP tool and the API say to an agent that sends an ask without saying why it is the owner's call. */
export const DECIDE_YOURSELF =
  "Decide this yourself: weigh the options and pick one, then tell the owner in a post. Send an ask only when it is the owner's call: a one-way door, a taste or values choice, or scope the owner must own. Then pass --owners-call <one-way|taste|values|scope> --owners-call-why '...'";

export type OwnersCall = { kind: "one-way" | "taste" | "values" | "scope"; reason: string };

/** The line the ask card shows under the question for an ask that carries an owner's call. */
export const callLine = (c: OwnersCall): string => `Your call · ${c.kind}: ${c.reason}`;

export interface Person {
  id?: number;
  handle: string;
  display_name?: string;
}

export interface AskView {
  id: number;
  conversation_id: number;
  conversation?: { id: number; title: string | null };
  thread_root_id?: number;
  asker: Person;
  question: string;
  urgent: boolean;
  state: "open" | "answered" | "dismissed" | "closed";
  close_reason?: string;
  options: { label: string; why: string; recommended?: boolean }[];
  chosen?: { kind: string; index?: number; text?: string };
  answer?: string;
  resolved_by?: Person;
  acked_at?: number;
  version: number;
  owners_call?: OwnersCall;
  snoozed_until?: number;
  owner_reply?: { id: number; text: string; at: number };
  answers?: string;
  revision?: number;
  changed?: string;
  /** "permission" | "decision" | "draft"; present on every ask once the permission ask ships. */
  kind?: "permission" | "decision" | "draft";
  permission?: { action: string; risk: string; undo?: string; one_way?: boolean; considered: string[]; confidence: number };
  history?: { version: number; event: string; to_state: string; by?: Person; at: number }[];
}

export interface NowView {
  now: number;
  poll_ms: number;
  badge: number;
  mentions: number;
  asks: AskView[];
  replied: AskView[];
  snoozed: AskView[];
  answered_today: AskView[];
  pending_adds: { conversation: { id: number; title: string | null }; person: Person; requested_by?: Person; at: number }[];
  machine_requests: { id: number; name: string; user_code: string }[];
}

export interface AskSpec {
  question?: string;
  rec?: [label: string, why: string];
  alts?: [label: string, why: string][];
  urgent?: boolean;
  thread?: number;
  clientId?: string;
  /** Why only the owner can decide; the default is a taste call. null leaves it out, to test the refusal. */
  ownersCall?: OwnersCall | null;
}

/** The body of `POST /api/asks`: "Merge it" recommended, "Hold it" the alternative, unless the spec says otherwise. */
export function askBody(conv: number, o: AskSpec = {}): Record<string, unknown> {
  const [label, why] = o.rec ?? ["Merge it", "All 11 checks pass"];
  return {
    conversation_id: conv,
    client_id: o.clientId ?? clientId(),
    question: o.question ?? QUESTION,
    recommended: { label, why },
    alternatives: (o.alts ?? [["Hold it", "Wait for #412"]]).map(([l, w]) => ({ label: l, why: w })),
    ...(o.ownersCall === null ? {} : { owners_call: o.ownersCall ?? { kind: "taste", reason: "Both names read fine; it is your voice" } }),
    ...(o.urgent ? { urgent: true } : {}),
    ...(o.thread ? { thread_root_id: o.thread } : {}),
  };
}

/** `POST /api/asks` with a lease. The raw answer. */
export function postAsk(srv: ServerHandle, lease: string, body: Record<string, unknown>): Promise<Res> {
  return send(srv.target, "POST", "/api/asks", { json: body, ...bearer(lease) });
}

/** An agent asks and it must open (201). Returns the ask id (the id of the ask message). */
export async function agentAsks(srv: ServerHandle, lease: string, conv: number, o: AskSpec = {}): Promise<number> {
  return (must(await postAsk(srv, lease, askBody(conv, o)), `ask ${JSON.stringify(o.question ?? QUESTION)}`, 201).json().ask as AskView).id;
}

/** `GET /api/asks/:id` as the owner. */
export async function askOf(owner: Owner, id: number): Promise<AskView> {
  return must(await owner.client.get(`/api/asks/${id}`), `get ask ${id}`).json().ask as AskView;
}

/** `GET /api/asks/:id` with a lease. */
export async function askOfAgent(srv: ServerHandle, lease: string, id: number): Promise<AskView> {
  return must(await send(srv.target, "GET", `/api/asks/${id}`, bearer(lease)), `get ask ${id} as agent`).json().ask as AskView;
}

/** `GET /api/now` as the owner. */
export async function nowOf(owner: Owner): Promise<NowView> {
  return must(await owner.client.get("/api/now"), "get now").json() as NowView;
}

export type Answer = { choice: "recommended" } | { choice: "alternative"; index: number } | { choice: "custom"; text: string };

/** `POST /api/asks/:id/answer` as the owner. The raw answer. */
export function answerAsk(owner: Owner, id: number, a: Answer = { choice: "recommended" }, extra: Record<string, unknown> = {}): Promise<Res> {
  return owner.client.post(`/api/asks/${id}/answer`, { client_id: clientId(), ...a, ...extra });
}

/** `POST /api/asks/:id/<event>` as the owner for dismiss and undismiss. The raw answer. */
export function markAsk(owner: Owner, id: number, event: "dismiss" | "undismiss", extra: Record<string, unknown> = {}): Promise<Res> {
  return owner.client.post(`/api/asks/${id}/${event}`, { client_id: clientId(), ...extra });
}

/** `POST /api/asks/:id/withdraw` with the asker's lease. The raw answer. */
export function withdrawAsk(srv: ServerHandle, lease: string, id: number): Promise<Res> {
  return send(srv.target, "POST", `/api/asks/${id}/withdraw`, { json: { client_id: clientId() }, ...bearer(lease) });
}

/** `PUT /api/asks/:id/snooze` as the owner. The raw answer. */
export function snoozeAsk(owner: Owner, id: number, body: { preset?: string; until?: number; tz?: string }): Promise<Res> {
  return owner.client.request("PUT", `/api/asks/${id}/snooze`, { csrf: true, json: body });
}

/** The ask must be in this state (and close reason). */
export async function expectState(owner: Owner, id: number): Promise<string> {
  const a = await askOf(owner, id);
  return a.close_reason ? `${a.state} (${a.close_reason})` : a.state;
}

/** Messages that answer asks, among a conversation's main list and every thread: counted straight from the data file of the encryption-off build. */
export function answerMessages(dataDir: string, askId: number): { id: number; body: string; author_id: number }[] {
  const db = plainDb(dataDir);
  try {
    return db.prepare("SELECT id, body, author_id FROM messages WHERE answers_ask_id = ? ORDER BY id").all(askId) as { id: number; body: string; author_id: number }[];
  } finally {
    db.close();
  }
}

/** The ask world: a fresh server, owner "drew", machine "box-2" with "devtool" and "docs", conversation "Ship search filters" and a lease for each agent. */
export async function askWorld(
  server: (o?: ServerOptions) => Promise<ServerHandle>,
  o: { plaintext?: boolean; title?: string } = {},
): Promise<{ w: World; conv: number; devtool: { sid: string; lease: string }; docs: { sid: string; lease: string } }> {
  const w = await world(server, { agents: ["devtool", "docs"], ...(o.plaintext ? { plaintext: true } : {}) });
  const conv = await createConversation(w.owner, { title: o.title ?? "Ship search filters", participants: ["devtool", "docs"] });
  const devtool = await startSession(w.box, "devtool", "s1");
  const docs = await startSession(w.box, "docs", "s2");
  return { w, conv, devtool, docs };
}

// ---- the owner's browser -----------------------------------------------------------------------------------

/** The Now card of an ask: an article named by its question. */
export const askCard = (page: Page, question: string = QUESTION): Locator => page.getByRole("article", { name: question });

/** Open Now and wait until it has loaded. */
export async function openNow(page: Page, srv: ServerHandle): Promise<void> {
  await page.goto(`${srv.origin}/`);
  await page.getByRole("heading", { name: "Now", exact: true }).waitFor();
}

/** A fold of Now ("Snoozed", "Answered today"): its toggle button. Opens it when it is closed. */
export async function openFold(page: Page, name: string): Promise<void> {
  const toggle = page.getByRole("button", { name: new RegExp(`^${name}\\b`) });
  await toggle.waitFor();
  if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
}

/** Move the server clock so the time is `iso` (a UTC instant, "2026-10-16T18:00:00Z"), and keep it frozen there. */
export async function setServerTime(
  testApi: { freezeClock(): Promise<void>; advanceClock(ms: number): Promise<void> },
  owner: Owner,
  iso: string,
): Promise<void> {
  await testApi.freezeClock();
  await testApi.advanceClock(Date.parse(iso) - (await nowOf(owner)).now);
}

/** The owner replies in the thread rooted at `root` over the API. Returns the id of the reply message. */
export async function ownerRepliesIn(owner: Owner, conv: number, root: number, body: string): Promise<number> {
  const res = await owner.client.post(`/api/conversations/${conv}/messages`, { client_id: clientId(), body, thread_root_id: root });
  return Number(must(res, `owner replies in the thread of ${root}`, 201).json().id);
}

// ---- permission asks (an ask is a permission request: one confident action, its risk and undo, the alternatives rejected) -------------

/** What the API, the CLI and the MCP tool tell an agent that asks with a confidence under 80 (wire.GetConfidentFirst). */
export const GET_CONFIDENT_FIRST =
  "Get confident first: research it or run it by @advisor, then ask with --confidence 80 or more. Never hand the owner the thinking.";

export const ACTION = "Merge PR 415 into main";
export const RISK = "Checkout breaks until the fix lands";
export const UNDO = "Revert the merge commit";
export const CONSIDERED = ["Hold for PR 412: costs a day, gains nothing", "Squash first: loses the review history"];

/** The `permission` object of POST /api/asks. Pass `over` to change a field; a key set to undefined leaves the field out. */
export function permissionOf(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { action: ACTION, risk: RISK, undo: UNDO, considered: CONSIDERED, confidence: 90, ...over };
}

/** The body of a permission ask: no options, no owners_call. `top` adds or overrides top-level keys (question, draft, ...). */
export function permissionBody(conv: number, over: Record<string, unknown> = {}, top: Record<string, unknown> = {}): Record<string, unknown> {
  return { conversation_id: conv, client_id: clientId(), permission: permissionOf(over), ...top };
}

/** An agent asks for permission over the API and it must open (201). Returns the ask id. */
export async function agentAsksPermission(srv: ServerHandle, lease: string, conv: number, over: Record<string, unknown> = {}): Promise<number> {
  return (must(await postAsk(srv, lease, permissionBody(conv, over)), "permission ask", 201).json().ask as AskView).id;
}

/** `PATCH /api/asks/:id` with the asker's lease. The raw answer. */
export function patchAsk(srv: ServerHandle, lease: string, id: number, body: Record<string, unknown>): Promise<Res> {
  return send(srv.target, "PATCH", `/api/asks/${id}`, { json: body, ...bearer(lease) });
}

/** The CLI flags of a permission ask. `over` replaces a flag's value; null drops the flag. */
export function permissionArgs(conv: number, over: Partial<Record<"action" | "risk" | "undo" | "confidence", string | null>> & { oneWay?: boolean; considered?: string[] } = {}): string[] {
  const v = { action: ACTION, risk: RISK, undo: UNDO, confidence: "90", ...over };
  const flags: [string, string | null | undefined][] = [["--action", v.action], ["--risk", v.risk], ["--confidence", v.confidence]];
  if (over.oneWay) flags.push(["--one-way", ""]);
  else flags.push(["--undo", v.undo]);
  const args = ["ask"];
  for (const [f, val] of flags) if (val !== null && val !== undefined) args.push(f, ...(val === "" ? [] : [val]));
  for (const c of over.considered ?? CONSIDERED) args.push("--considered", c);
  return [...args, String(conv)];
}

/** Text of the "Not this" reply box on a permission card, for the agent @handle. */
export const notThisBox = (card: Locator, handle = "devtool"): Locator => card.getByRole("textbox", { name: `Why not? @${handle} reads this.` });

/** The parts of a permission card must read in this order (its visible text). */
export async function expectInOrder(card: Locator, parts: string[]): Promise<void> {
  const text = await card.innerText();
  const at = parts.map((p) => text.indexOf(p));
  expect(at.every((i) => i >= 0), `${JSON.stringify(parts)} in ${JSON.stringify(text)}`).toBe(true);
  expect(at).toEqual([...at].sort((a, b) => a - b));
}
