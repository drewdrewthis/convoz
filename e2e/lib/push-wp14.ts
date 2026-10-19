import crypto from "node:crypto";
import type { ServerHandle, ServerOptions } from "./fixtures.ts";
import { send, type Res } from "./http.ts";
import { allow, bearer, clientId, createAgent, lease, loginMachine, plainDb, type LoggedIn } from "./machines.ts";
import { bootstrapOwner, must, type Owner } from "./owner.ts";

/**
 * Helpers of the notification scenarios (WP14). The contract they rely on:
 *   GET  /api/push/vapid-key            {public_key}
 *   GET  /api/push/subscriptions        {subscriptions:[{id, host, current, state:"active"|"disabled", disabled_reason?, created_at}]}
 *   POST /api/push/subscriptions        {endpoint, keys:{p256dh, auth}} -> 201 {subscription}; 400 for an endpoint off the allow-list or bad keys
 *   PUT  /api/push/focus                {conversation_id|null} -> 204   (the device looks at that conversation)
 *   Test build only, the fake push service (it records every push, any host):
 *   GET  /__test/push                   {received:[{endpoint, topic, urgency, ttl, content_encoding, size, body (base64 of the encrypted record), status}]}
 *   POST /__test/push                   {status?:{<endpoint>:410}, hold?:bool, rewind?:bool}
 * The notification log is the `notifications` table of the encryption-off data file.
 */

export const PUSH_HOST = "push.testonly.example";

/** A browser's push subscription: its own key pair and auth secret, so a test can decrypt what the server sends (RFC 8291). */
export interface Sub {
  endpoint: string;
  ecdh: crypto.ECDH;
  auth: Buffer;
}

export function newSub(endpoint = `https://${PUSH_HOST}/send/${crypto.randomBytes(8).toString("hex")}`): Sub {
  const ecdh = crypto.createECDH("prime256v1");
  ecdh.generateKeys();
  return { endpoint, ecdh, auth: crypto.randomBytes(16) };
}

const b64u = (b: Buffer): string => b.toString("base64url");

/** The body of `POST /api/push/subscriptions` for a subscription. */
export const subBody = (s: Sub) => ({ endpoint: s.endpoint, keys: { p256dh: b64u(s.ecdh.getPublicKey()), auth: b64u(s.auth) } });

export function subscribe(owner: Owner, s: Sub, endpoint?: string): Promise<Res> {
  return owner.client.post("/api/push/subscriptions", { ...subBody(s), ...(endpoint ? { endpoint } : {}) });
}

export interface Received {
  endpoint: string;
  topic: string;
  urgency: string;
  ttl: string;
  content_encoding: string;
  size: number;
  body: string;
  status: number;
}

export async function received(srv: ServerHandle): Promise<Received[]> {
  return must(await send(srv.target, "GET", "/__test/push"), "read the fake push service").json().received as Received[];
}

export async function fakePush(srv: ServerHandle, o: { status?: Record<string, number>; hold?: boolean; rewind?: boolean }): Promise<void> {
  must(await send(srv.target, "POST", "/__test/push", { json: o }), "script the fake push service");
}

export interface Shown {
  v: number;
  reason: string;
  title: string;
  body?: string;
  url: string;
  badge: number;
  topic: string;
}

/** Decrypt one push the way the browser does: RFC 8291 over RFC 8188 (aes128gcm), one record. */
export function decrypt(s: Sub, rec: Received): Shown {
  const data = Buffer.from(rec.body, "base64");
  const salt = data.subarray(0, 16);
  const idLen = data[20]!;
  const asPublic = data.subarray(21, 21 + idLen);
  const cipher = data.subarray(21 + idLen);
  const secret = s.ecdh.computeSecret(asPublic);
  const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0"), s.ecdh.getPublicKey(), asPublic]);
  const ikm = Buffer.from(crypto.hkdfSync("sha256", secret, s.auth, keyInfo, 32));
  const cek = Buffer.from(crypto.hkdfSync("sha256", ikm, salt, "Content-Encoding: aes128gcm\0", 16));
  const nonce = Buffer.from(crypto.hkdfSync("sha256", ikm, salt, "Content-Encoding: nonce\0", 12));
  const d = crypto.createDecipheriv("aes-128-gcm", cek, nonce);
  d.setAuthTag(cipher.subarray(cipher.length - 16));
  const plain = Buffer.concat([d.update(cipher.subarray(0, cipher.length - 16)), d.final()]);
  let end = plain.length;
  while (end > 0 && plain[end - 1] === 0) end--;
  if (plain[end - 1] !== 2) throw new Error("push record has no padding delimiter");
  return JSON.parse(plain.subarray(0, end - 1).toString("utf8")) as Shown;
}

export interface Note {
  id: number;
  reason: string;
  decision: string;
  suppressed_reason: string | null;
  conversation_id: number | null;
  topic: string;
}

/** The notification log, oldest first. */
export function notes(dataDir: string): Note[] {
  const db = plainDb(dataDir);
  try {
    return db.prepare("SELECT id, reason, decision, suppressed_reason, conversation_id, topic FROM notifications ORDER BY id").all() as unknown as Note[];
  } finally {
    db.close();
  }
}

/** Wait until the push worker has handled every event so far (its offset reached the newest event). */
export async function settled(dataDir: string, ms = 10_000): Promise<void> {
  const until = Date.now() + ms;
  for (;;) {
    const db = plainDb(dataDir);
    let done = false;
    try {
      const max = (db.prepare("SELECT COALESCE(MAX(seq), 0) AS m FROM events").get() as { m: number }).m;
      const off = db.prepare("SELECT last_event_id AS o FROM consumer_offsets WHERE consumer = 'push'").get() as { o: number } | undefined;
      done = off !== undefined && off.o >= max;
    } finally {
      db.close();
    }
    if (done) return;
    if (Date.now() > until) throw new Error("the push worker did not catch up");
    await new Promise((r) => setTimeout(r, 100));
  }
}

export interface PushWorld {
  srv: ServerHandle;
  owner: Owner;
  sub: Sub;
  box: LoggedIn;
  conv: number;
  dev: string;
  docsId: number;
  dataDir: string;
}

/**
 * The Background of notifications.feature: a fresh server with owner "drew", machine "box-2" with "devtool" ("Dev Tool") and "docs",
 * conversation "Ship search filters" with "devtool", and the owner's browser subscribed to the fake push service. The push worker has
 * caught up with the set-up before the subscription is made, so none of the set-up pushes.
 */
export async function pushWorld(
  server: (o?: ServerOptions) => Promise<ServerHandle>,
  dataDir: string,
  o: { env?: Record<string, string> } = {},
): Promise<PushWorld> {
  const srv = await server({ host: "localhost", adminSocket: true, env: { CONVOZ_TEST_POLL_MS: "250", CONVOZ_TEST_PLAINTEXT: "1", ...(o.env ?? {}) } });
  const owner = await bootstrapOwner(srv);
  await createAgent(owner, "devtool", "Dev Tool");
  const docs = await createAgent(owner, "docs", "Docs");
  const box = await loginMachine(srv, owner, "box-2", allow("devtool", "docs"));
  const conv = must(
    await owner.client.post("/api/conversations", { client_id: clientId(), title: "Ship search filters", participants: ["devtool"] }),
    "create conversation",
    201,
  ).json().conversation.id as number;
  const dev = await lease(srv, box.key, { as: "devtool", label: "dev" });
  await settled(dataDir);
  const sub = newSub();
  must(await subscribe(owner, sub), "subscribe", 201);
  return { srv, owner, sub, box, conv, dev, docsId: docs.id, dataDir };
}

/** An agent asks in a conversation; returns the ask id. */
export async function ask(w: PushWorld, o: { urgent?: boolean; question?: string; lease?: string } = {}): Promise<number> {
  const body = {
    conversation_id: w.conv,
    client_id: clientId(),
    question: o.question ?? "Merge #415 on its own?",
    recommended: { label: "Merge it", why: "All 11 checks pass" },
    alternatives: [{ label: "Hold it", why: "Wait for #412" }],
    owners_call: { kind: "taste", reason: "Both names read fine; it is your voice" },
    ...(o.urgent ? { urgent: true } : {}),
  };
  const res = await send(w.srv.target, "POST", "/api/asks", { json: body, ...bearer(o.lease ?? w.dev) });
  return must(res, "ask", 201).json().ask.id as number;
}

/** devtool posts a message in the conversation. */
export async function say(w: PushWorld, body: string, extra: Record<string, unknown> = {}): Promise<number> {
  const res = await send(w.srv.target, "POST", `/api/conversations/${w.conv}/messages`, { json: { client_id: clientId(), body, needs_you: false, ...extra }, ...bearer(w.dev) });
  return Number(must(res, "devtool posts", 201).json().id);
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** The owner's settings write. */
export async function setSetting(owner: Owner, key: string, value: unknown): Promise<void> {
  must(await owner.client.request("PATCH", "/api/settings", { csrf: true, json: { scope: "user", key, value } }), `set ${key}`);
}

/** Quiet hours that contain the server's clock now: an hour either side, in UTC. */
export function quietAround(serverNowMs: number): { start: string; end: string; tz: string } {
  const h = new Date(serverNowMs).getUTCHours();
  const hh = (n: number) => `${String((n + 24) % 24).padStart(2, "0")}:00`;
  return { start: hh(h - 1), end: hh(h + 1), tz: "UTC" };
}
