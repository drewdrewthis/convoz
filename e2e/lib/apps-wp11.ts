import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import type { BrowserContext, Locator, Page } from "@playwright/test";
import { agentPost, createConversation, startSession } from "./chat.ts";
import type { ServerHandle, ServerOptions } from "./fixtures.ts";
import { send, type Res } from "./http.ts";
import { bearer, clientId, plainDb } from "./machines.ts";
import { must } from "./owner.ts";
import { repoRoot } from "./paths.ts";
import { browserWorld, world, type World } from "./wp3.ts";

/**
 * Helpers of the apps scenarios (WP11: apps-host.wp11.spec.ts, security.wp11.spec.ts, messages-types.wp11.spec.ts). The contract is
 * packages/contracts/paths/appkit.yaml:
 *   POST /api/apps/validate                {app}  -> 200 {ok,type,bytes} | 400 {error:{code,message,path}}
 *   POST /api/apps/bundles[?kind=image]    raw bytes (a lease) -> 201 {upload,sha256,size}   (the stand-in of the upload module)
 *   GET  /api/messages/:id/app             -> {app}
 *   GET  /api/apps/:message_id/frame?h=    (owner cookie, Sec-Fetch-Dest: iframe) -> the bundle with the frame CSP
 *   POST /api/conversations/:id/messages   {client_id, via_app:{message_id, result}}  (owner)
 * The page contract (roles, names, data attributes) is the one of apps/web/src/features/apps-host: every app is a `region` named by its
 * title with data-app-type and data-app-state; the confirm sheet is the dialog "Confirm app result".
 */

type Fx = { server: (o?: ServerOptions) => Promise<ServerHandle>; page: Page; context: BrowserContext };
type Lease = { sid: string; lease: string };

export const TITLE = "Ship search filters";

/** The CSP of a frame document, as written in docs/messages-apps-spec.md §5.4. */
export const FRAME_CSP =
  "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; " +
  "media-src data: blob:; connect-src 'none'; frame-src 'none'; worker-src 'none'; child-src 'none'; object-src 'none'; manifest-src 'none'; " +
  "form-action 'none'; base-uri 'none'; frame-ancestors 'self'";

export interface AppsWorld {
  w: World;
  /** Conversation 41 "Ship search filters" with "devtool" and "docs". */
  conv: number;
  devtool: Lease;
  docs: Lease;
}

/**
 * Background: a fresh server (encryption-off build, so a scenario can look into the data file) with owner "drew", machine "box-2"
 * with allow-list "devtool" and "docs", and both active in conversation 41 "Ship search filters". With `browser` the owner's browser is signed in.
 */
export async function appsWorld(fx: Partial<Fx> & Pick<Fx, "server"> & { browser?: boolean }): Promise<AppsWorld> {
  const agents = ["devtool", "docs"];
  const w = fx.browser ? await browserWorld(fx as Fx, { agents, plaintext: true }) : await world(fx.server, { agents, plaintext: true });
  const conv = await createConversation(w.owner, { participants: agents, title: TITLE });
  return { w, conv, devtool: await startSession(w.box, "devtool", "dev"), docs: await startSession(w.box, "docs", "docs") };
}

// ---- the examples -------------------------------------------------------------------------------------------

interface Example {
  name: string;
  schema: string;
  data: any;
  expect?: { code: string; path: string };
}

export function examples(kind: "valid" | "invalid"): Example[] {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, "schemas", "examples", `${kind}.json`), "utf8"));
}

/** A copy of a valid example app of schemas/examples/valid.json. */
export function validApp(name: string): any {
  const e = examples("valid").find((x) => x.name === name);
  if (!e) throw new Error(`no valid example ${name}`);
  return structuredClone(e.data);
}

// ---- files an app points at ----------------------------------------------------------------------------------

const crc = (b: Buffer): Buffer => {
  const out = Buffer.alloc(4);
  out.writeUInt32BE(zlib.crc32(b));
  return out;
};

/** A 1x1 PNG of one colour. */
export function png(r: number, g: number, b: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    return Buffer.concat([len, body, crc(body)]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(Buffer.from([0, r, g, b]))), chunk("IEND", Buffer.alloc(0))]);
}

export interface Stored {
  upload: string;
  sha256: string;
  size: number;
}

/** `POST /api/apps/bundles` with a lease. The raw answer. */
export function putFile(srv: ServerHandle, lease: string, bytes: Buffer, kind: "app" | "image" = "app"): Promise<Res> {
  return send(srv.target, "POST", `/api/apps/bundles${kind === "image" ? "?kind=image" : ""}`, {
    bytes,
    headers: { "Content-Type": kind === "image" ? "image/png" : "text/html", ...bearer(lease).headers },
    timeoutMs: 20_000,
  });
}

export async function stored(srv: ServerHandle, lease: string, bytes: Buffer, kind: "app" | "image" = "app"): Promise<Stored> {
  return must(await putFile(srv, lease, bytes, kind), `store a ${kind} file`, 201).json() as Stored;
}

// ---- Tier-2 apps -----------------------------------------------------------------------------------------------

const runtime = (): string => fs.readFileSync(path.join(repoRoot, "apps", "convoz", "internal", "appbuild", "runtime", "runtime.js"), "utf8");

/** A frame document: the runtime first, then `body` (markup) and `script`. */
export function frameHtml(body: string, script = "", o: { runtime?: boolean } = {}): string {
  return `<!doctype html>\n${o.runtime === false ? "" : `<script>${runtime()}</script>\n`}<meta charset="utf-8">\n<body>${body}<script>${script}</script></body>\n`;
}

/** The same document padded with a comment to exactly `size` bytes. */
export function padded(html: string, size: number): Buffer {
  const need = size - Buffer.byteLength(html);
  if (need < 9) throw new Error("the document is larger than the size");
  return Buffer.from(html + `<!--${"x".repeat(need - 7)}-->`);
}

export const manifest = (o: { name?: string; results?: boolean; initial?: number } = {}) => ({
  name: o.name ?? "Test app",
  version: "1.0.0",
  icon: "app",
  height: { initial: o.initial ?? 160, min: 80, max: 400 },
  results: o.results ?? true,
  permissions: [],
  bridge: 1,
  kit: "1.0.0",
});

/** A frame app (wire form) over a stored bundle. */
export function frameApp(bundle: Stored, o: { title?: string; fallback?: string; results?: boolean; data?: unknown } = {}): any {
  const title = o.title ?? "Test app";
  return {
    v: 1,
    type: "frame",
    title,
    fallback: o.fallback ?? `${title}: a small app.`,
    height: 160,
    props: { bundle, manifest: manifest({ name: title, results: o.results }), ...(o.data === undefined ? {} : { data: o.data }) },
  };
}

/** Store a bundle and post the frame app over it. Returns the message id. */
export async function postFrame(a: AppsWorld, html: string | Buffer, o: { title?: string; fallback?: string; results?: boolean; data?: unknown; body?: string; thread?: number } = {}): Promise<number> {
  const bundle = await stored(a.w.srv, a.devtool.lease, Buffer.isBuffer(html) ? html : Buffer.from(html));
  return postApp(a, frameApp(bundle, o), o.body ?? o.title ?? "App", o.thread ? { thread_root_id: o.thread } : {});
}

// ---- posting ----------------------------------------------------------------------------------------------------

/** An agent posts an app. The raw answer. */
export function postAppRaw(a: AppsWorld, app: unknown, body = "An app", extra: Record<string, unknown> = {}, lease = a.devtool.lease): Promise<Res> {
  return agentPost(a.w.srv, lease, a.conv, body, { app, ...extra });
}

/** An agent posts an app and it must be stored (201). Returns the message id. */
export async function postApp(a: AppsWorld, app: unknown, body = "An app", extra: Record<string, unknown> = {}, lease = a.devtool.lease): Promise<number> {
  return Number(must(await postAppRaw(a, app, body, extra, lease), `post the ${(app as any).type} app`, 201).json().id);
}

/** The owner sends the result of an app (`via_app`). The raw answer. */
export function ownerResult(a: AppsWorld, messageId: number, result: unknown, extra: Record<string, unknown> = {}): Promise<Res> {
  return a.w.owner.client.post(`/api/conversations/${a.conv}/messages`, { client_id: clientId(), via_app: { message_id: messageId, result }, ...extra });
}

export const pickerResult = (ids: string[], summary = `Picked ${ids.join(", ")}`) => ({ v: 1, source: "picker", summary, value: { selected: ids } });

export interface Wire {
  id: number;
  body: string;
  author: { handle: string };
  kind?: string;
  app?: any;
  via_app?: { message_id: number; agent: { handle: string }; result: any };
  thread_root_id?: number;
}

/** The newest messages of the conversation as the owner reads them. */
export async function pageOf(a: AppsWorld, query = "limit=100"): Promise<Wire[]> {
  return must(await a.w.owner.client.get(`/api/conversations/${a.conv}/messages?${query}`), "read the page").json().messages as Wire[];
}

export async function thread(a: AppsWorld, root: number): Promise<Wire[]> {
  return pageOf(a, `thread=${root}&limit=100`);
}

/** Rows of the data file of the encryption-off build, counted per table. */
export function rowCounts(dataDir: string, tables: string[]): Record<string, number> {
  const db = plainDb(dataDir);
  try {
    return Object.fromEntries(tables.map((t) => [t, (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n]));
  } finally {
    db.close();
  }
}

/** Messages that went through an app, from the data file. */
export function viaAppRows(dataDir: string): { id: number; author_id: number; via_app_agent_id: number; via_app_message_id: number; body: string }[] {
  const db = plainDb(dataDir);
  try {
    return db.prepare("SELECT id, author_id, via_app_agent_id, via_app_message_id, body FROM messages WHERE via_app_message_id IS NOT NULL ORDER BY id").all() as any;
  } finally {
    db.close();
  }
}

export function identityId(dataDir: string, handle: string): number {
  const db = plainDb(dataDir);
  try {
    return (db.prepare("SELECT id FROM identities WHERE handle = ?").get(handle) as { id: number }).id;
  } finally {
    db.close();
  }
}

// ---- the owner's browser ------------------------------------------------------------------------------------------

/** Open a conversation and wait for its heading. */
export async function openConversation(page: Page, srv: ServerHandle, conv: number): Promise<void> {
  await page.goto(`${srv.origin}/chats/${conv}`);
  await page.getByRole("heading", { name: TITLE, exact: true, level: 1 }).waitFor();
}

/** The card of an app: a region named by its title. */
export const appCard = (page: Page, title: string): Locator => page.getByRole("region", { name: title, exact: true });

/** The frame of an open Tier-2 app. */
export const appFrame = (page: Page, title: string) => page.frameLocator(`iframe[title="${title} (sandboxed)"]`);

/** The sheet the host draws for a result. */
export const resultSheet = (page: Page): Locator => page.getByRole("dialog", { name: "Confirm app result" });

/** Tap "Open app" on a Tier-2 card and wait until the frame has run (its sentinel text shows). */
export async function openApp(page: Page, title: string, sentinel: string): Promise<void> {
  await appCard(page, title).getByRole("button", { name: /^Open app/ }).click();
  await appFrame(page, title).getByText(sentinel, { exact: false }).first().waitFor();
}

/** Every request the page makes, by URL, from now on. */
export function requestLog(page: Page): string[] {
  const urls: string[] = [];
  page.on("request", (r) => urls.push(r.url()));
  return urls;
}

/** Errors the page prints to its console, and uncaught errors, from now on. */
export function consoleErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(String(e)));
  return errors;
}
