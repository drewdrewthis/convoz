import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { BrowserContext, Locator, Page } from "@playwright/test";
import type { ServerHandle } from "./fixtures.ts";
import { Client, send, type Res } from "./http.ts";
import { bootstrapOwner, must, uiSignIn, type Owner } from "./owner.ts";
import type { SoftAuthenticator } from "./soft-authenticator.ts";
import { webauthn } from "./webauthn-browser.ts";

/**
 * Helpers for the S1b scenarios: owner actions with a single-use step-up, the device flow and machine keys over
 * HTTP, leases, a plain-text view of the test build's data file, and the owner console driven in chromium.
 * The routes, bodies and messages they rely on are in the contract block at the top of tests/machine-login.spec.ts.
 */

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;

/** The scopes an approval gives when the owner changes nothing: read, post, ask, status, upload (bitmask 31). */
export const DEFAULT_SCOPES = ["read", "post", "ask", "status", "upload"];

/** An allow-list on the wire: `identities` are handles, `globs` use `*` and `?`. */
export interface Allow {
  mode: "list" | "any";
  identities: string[];
  globs: string[];
}
export const ANY: Allow = { mode: "any", identities: [], globs: [] };
/** A list allow-list from handles and globs ("dev-*" is a glob). */
export const allow = (...entries: string[]): Allow => ({
  mode: "list",
  identities: entries.filter((e) => !/[*?]/.test(e)),
  globs: entries.filter((e) => /[*?]/.test(e)),
});

// ---- step-up and owner actions ---------------------------------------------------------------------

/** What `stepUp` needs: a signed-in device and the passkey on it. */
export interface Stepper {
  client: Client;
  soft: SoftAuthenticator;
}

/** A fresh single-use step-up for one action (and target): options, a passkey assertion, verify. Returns its id. */
export async function stepUp(who: Stepper, action: string, targetId?: number): Promise<number> {
  const opt = must(
    await who.client.post("/api/auth/step-up/options", targetId === undefined ? { action } : { action, target_id: targetId }),
    `step-up options ${action}`,
  ).json();
  const credential = who.soft.get(opt.options.publicKey);
  const verify = must(await who.client.post("/api/auth/step-up/verify", { ceremony_id: opt.ceremony_id, credential }), `step-up verify ${action}`);
  return verify.json().step_up_id as number;
}

/** The request option that carries a step-up id. */
export const withStepUp = (id: number) => ({ headers: { "X-Convoz-Step-Up": String(id) } });

/** An owner request with its own fresh step-up for (action, target). */
export async function stepped(who: Stepper, method: string, route: string, body: unknown, action: string, targetId?: number): Promise<Res> {
  const id = await stepUp(who, action, targetId);
  return who.client.request(method, route, { csrf: true, json: body, ...withStepUp(id) });
}

export interface AgentRow {
  id: number;
  handle: string;
  display_name: string;
  kind: string;
}

/** Create agents the way Crew does (`identity.create` step-up). The display name defaults to the handle with a capital. */
export async function createAgent(owner: Owner, handle: string, displayName = handle.charAt(0).toUpperCase() + handle.slice(1)): Promise<AgentRow> {
  const res = await stepped(owner, "POST", "/api/crew/agents", { handle, display_name: displayName }, "identity.create");
  return must(res, `create agent ${handle}`, 201).json().identity as AgentRow;
}

export async function createAgents(owner: Owner, ...handles: string[]): Promise<Record<string, AgentRow>> {
  const out: Record<string, AgentRow> = {};
  for (const h of handles) out[h] = await createAgent(owner, h);
  return out;
}

// ---- device flow -----------------------------------------------------------------------------------

let sourceCounter = 0;
/** A distinct requesting address for the unix listener (`tailscale serve` writes X-Forwarded-For); over TCP the header is ignored. */
export function freshSource(): Record<string, string> {
  sourceCounter += 1;
  return { "X-Forwarded-For": `198.51.100.${(sourceCounter % 250) + 1}` };
}

/** `POST /api/device/code`, as the CLI sends it. */
export function requestDeviceCode(srv: ServerHandle, name: string, headers: Record<string, string> = {}): Promise<Res> {
  return send(srv.target, "POST", "/api/device/code", {
    json: { name, host_info: { hostname: `${name}.TESTONLY.local`, os: "linux", arch: "amd64", cli_version: "0.0.0-TESTONLY" } },
    headers,
  });
}

/** `POST /api/device/token`. */
export function pollToken(srv: ServerHandle, deviceCode: string, headers: Record<string, string> = {}): Promise<Res> {
  return send(srv.target, "POST", "/api/device/token", { json: { device_code: deviceCode }, headers });
}

/** Make the next device-flow user codes (testhooks build): `POST /__test/user-codes {codes}`. */
export async function seedUserCodes(srv: ServerHandle, codes: string[]): Promise<void> {
  must(await send(srv.target, "POST", "/__test/user-codes", { json: { codes } }), "seed user codes");
}

export interface PendingRequest {
  id: number;
  name: string;
  user_code: string;
  host_info: Record<string, string> | null;
  source_ip: string | null;
  node_name: string | null;
  created_at: number;
  expires_at: number;
}

/** `GET /api/machines/requests`: the pending requests, oldest first. */
export async function pendingRequests(owner: Owner): Promise<PendingRequest[]> {
  return must(await owner.client.get("/api/machines/requests"), "list machine requests").json().requests as PendingRequest[];
}

export interface Requested {
  deviceCode: string;
  userCode: string;
  requestId: number;
  res: Res;
}

/** Start a device-flow request and find it in the owner's list. */
export async function requestMachine(srv: ServerHandle, owner: Owner, name: string, headers: Record<string, string> = {}): Promise<Requested> {
  const res = must(await requestDeviceCode(srv, name, headers), `device code for ${name}`);
  const body = res.json();
  const req = (await pendingRequests(owner)).find((r) => r.user_code === body.user_code);
  if (!req) throw new Error(`request ${body.user_code} for ${name} is not in GET /api/machines/requests`);
  return { deviceCode: body.device_code as string, userCode: body.user_code as string, requestId: req.id, res };
}

export interface ApproveOptions {
  /** Defaults to the requested name. */
  name?: string;
  allow?: Allow;
  /** Scope names; defaults to DEFAULT_SCOPES. */
  scopes?: string[];
}

/** Approve with the owner's session alone (no passkey check, no code). Returns the raw answer. */
export function approve(owner: Owner, requestId: number, o: ApproveOptions = {}): Promise<Res> {
  const body = {
    ...(o.name ? { name: o.name } : {}),
    allow: o.allow ?? ANY,
    ...(o.scopes ? { scopes: o.scopes } : {}),
  };
  return owner.client.post(`/api/machines/requests/${requestId}/approve`, body);
}

/** Revoke an agent's key (the app's "Revoke key"): the owner's session alone, no passkey check. */
export function revokeAgentKey(owner: Owner, identityId: number): Promise<Res> {
  return owner.client.post(`/api/identities/${identityId}/disable`, {});
}

export interface LoggedIn {
  id: number;
  name: string;
  /** The machine key (`cvz_m_TESTONLY...`). */
  key: string;
  deviceCode: string;
}

/**
 * A machine logged in over the API: request, approve with a step-up, fetch the key once.
 * On the unix listener each login comes from a fresh source address, so the per-source limits do not block fixtures.
 */
export async function loginMachine(
  srv: ServerHandle,
  owner: Owner,
  name: string,
  list: Allow = ANY,
  o: { scopes?: string[] } = {},
): Promise<LoggedIn> {
  const headers = srv.unixPath ? freshSource() : {};
  const req = await requestMachine(srv, owner, name, headers);
  must(await approve(owner, req.requestId, { allow: list, ...(o.scopes ? { scopes: o.scopes } : {}) }), `approve ${name}`, 201);
  const tok = must(await pollToken(srv, req.deviceCode, headers), `fetch key of ${name}`).json();
  return { id: tok.machine_id as number, name: tok.machine_name as string, key: tok.machine_key as string, deviceCode: req.deviceCode };
}

// ---- machine keys and leases -----------------------------------------------------------------------

/** The request option that carries a machine key or a lease. */
export const bearer = (token: string) => ({ headers: { Authorization: `Bearer ${token}` } });

/** A client id that is valid (8 to 64 characters) and unique. */
export const clientId = (): string => `claude-TESTONLY-${crypto.randomBytes(5).toString("hex")}`;

export interface MintOptions {
  as: string;
  clientId?: string;
  label?: string;
  /** Make the identity too (needs the create_identity scope). */
  create?: { display_name?: string; description?: string; avatar_svg?: string; conversation_id?: number; request?: string };
}

/** `POST /api/sessions` with a machine key. 201 `{lease, session:{id, identity, machine, client_id, label, expires_at}}`. */
export function mintSession(srv: ServerHandle, key: string, o: MintOptions): Promise<Res> {
  return send(srv.target, "POST", "/api/sessions", {
    json: { as: o.as, client_id: o.clientId ?? clientId(), label: o.label ?? "TESTONLY label", ...(o.create ? { create: o.create } : {}) },
    ...bearer(key),
  });
}

/** A waiting identity request of a logged-in machine, as Now lists it. */
export interface IdentityRequestRow {
  ref: string;
  handle: string;
  display_name: string;
  description: string;
  avatar_url: string | null;
  conversation: { id: number; title: string } | null;
  machine: string;
  machine_id: number;
  created_at: number;
  expires_at: number;
}

/** `GET /api/now` identity_requests: the agents on logged-in machines that wait for the owner. */
export async function identityRequests(owner: Owner): Promise<IdentityRequestRow[]> {
  return must(await owner.client.get("/api/now"), "now").json().identity_requests as IdentityRequestRow[];
}

/** One tap on the card of an identity request: the owner's session alone. */
export const approveIdentity = (owner: Owner, ref: string): Promise<Res> => owner.client.post(`/api/identity-requests/${ref}/approve`, {});
export const denyIdentity = (owner: Owner, ref: string): Promise<Res> => owner.client.post(`/api/identity-requests/${ref}/deny`, {});

/** The lease of a successful mint. */
export async function lease(srv: ServerHandle, key: string, o: MintOptions): Promise<string> {
  return must(await mintSession(srv, key, o), `mint a lease as ${o.as}`, 201).json().lease as string;
}

/** `GET /api/me` with a lease: `{identity, machine, session, scopes, live_sessions}`. */
export function whoamiApi(srv: ServerHandle, token: string): Promise<Res> {
  return send(srv.target, "GET", "/api/me", bearer(token));
}

export interface SessionRow {
  id: number;
  identity: string;
  machine: string;
  client_id: string;
  label: string;
  state: "live" | "ended";
  end_reason: string | null;
  last_seen_at: number;
  expires_at: number;
}

/** `GET /api/sessions` (owner): what Crew → Sessions lists, newest first. */
export async function sessionsOf(owner: Owner): Promise<SessionRow[]> {
  return must(await owner.client.get("/api/sessions"), "list sessions").json().sessions as SessionRow[];
}

// ---- the data file of the encryption-off build -----------------------------------------------------

/**
 * Open the live data file of a server started with `CONVOZ_TEST_PLAINTEXT=1` (testhooks build; the plain VFS).
 * A second connection, the way the X-1 probes do it.
 */
export function plainDb(dataDir: string): DatabaseSync {
  const db = new DatabaseSync(path.join(dataDir, "convoz.db"));
  db.exec("PRAGMA busy_timeout = 5000");
  return db;
}

/** Every byte of the data file, its WAL and its shared-memory file, as one buffer. */
export function dataFileBytes(dataDir: string): Buffer {
  const parts: Buffer[] = [];
  for (const f of ["convoz.db", "convoz.db-wal", "convoz.db-shm"]) {
    try {
      parts.push(fs.readFileSync(path.join(dataDir, f)));
    } catch {
      /* no WAL yet */
    }
  }
  return Buffer.concat(parts);
}

/** How many times `needle` occurs in `hay`. */
export function countOf(hay: Buffer | string, needle: string): number {
  const text = typeof hay === "string" ? hay : hay.toString("latin1");
  return text.split(needle).length - 1;
}

// ---- the owner console in chromium -----------------------------------------------------------------

/**
 * A signed-in browser: the owner is made over the API, the passkey goes onto the page's virtual authenticator, and the page signs in.
 * Do any API step-ups BEFORE calling this: the browser's authenticator continues the signature counter from here.
 */
export async function browserOwner(srv: ServerHandle, page: Page, context: BrowserContext): Promise<Owner> {
  const owner = await bootstrapOwner(srv);
  await signInBrowser(srv, owner, page, context);
  return owner;
}

/** Put an existing owner's passkey on the page and sign in. */
export async function signInBrowser(srv: ServerHandle, owner: Owner, page: Page, context: BrowserContext): Promise<void> {
  const wa = await webauthn(context, page);
  await (await wa.add()).addCredential(owner.soft.exportForChromium());
  await uiSignIn(page, srv.origin);
}

/** The Now card of a machine request: an article named "<name> wants to connect". */
export const nowCard = (page: Page, name: string): Locator => page.getByRole("article", { name: `${name} wants to connect` });

/** One tap on Approve in the card: no sheet, no passkey prompt. */
export async function approveCard(page: Page, name: string): Promise<void> {
  await nowCard(page, name).getByRole("button", { name: "Approve", exact: true }).click();
}

/** One tap on Decline in the card. */
export async function declineCard(page: Page, name: string): Promise<void> {
  await nowCard(page, name).getByRole("button", { name: "Decline", exact: true }).click();
}
