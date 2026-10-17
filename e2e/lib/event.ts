import http from "node:http";
import type { AddressInfo } from "node:net";
import type { BrowserContext, CDPSession, Page } from "@playwright/test";
import { chatWorld, createConversation, type World } from "./chat.ts";
import { scenario } from "./scenario.ts";
import type { ServerHandle, ServerOptions } from "./fixtures.ts";
import { send, type Client, type Target } from "./http.ts";
import type { Owner } from "./owner.ts";
import { record } from "./transcript.ts";

/**
 * Helpers for the event backbone and sync scenarios (tests/platform.wp2.spec.ts, tests/poor-network.wp2.spec.ts).
 *
 * CONTRACT these scenarios pin (design §5.4, §5.5, §13; the routes are in packages/contracts/paths/event.yaml):
 *   GET /api/sync/snapshot    -> 200 {epoch, as_of_seq, cursor}                 cursor is "<epoch>:<seq>", the newest event now.
 *   GET /api/sync?cursor=&wait= -> 200 {cursor, events:[{seq, type, conversation_id?, message_id?, payload}], more}
 *                                  The events after the cursor that the caller may see, thin (ids and enums, at most 1 KB).
 *                                  `cursor` is the highest sequence scanned. With `wait` (seconds, at most 25) and no event the
 *                                  request is held. A cursor of another epoch, or ahead of the log, gets 200 {reset:true, reason}.
 *   GET /api/stream           -> frames `event: <type>`, `id: <epoch>:<seq>`, `data: {..., prev_seq_for_you}`; `: hb` every 15 s;
 *                                a stream that falls more than 256 events behind gets `event: reset` `data: {"reason":"slow"}` and is closed.
 */

export const SHIP = "Ship search filters";

/** Background of the platform and poor-network scenarios: the chat world and conversation 41 "Ship search filters" with "devtool" in it. */
export async function platformWorld(
  server: (o?: ServerOptions) => Promise<ServerHandle>,
  o: { env?: Record<string, string> } = {},
): Promise<{ w: World; conv: number }> {
  const w = await chatWorld(server, { agents: ["devtool"], ...(o.env ? { env: o.env } : {}) });
  const conv = await createConversation(w.owner, { participants: ["devtool"], title: SHIP });
  return { w, conv };
}

// ---- GET /api/sync and /api/sync/snapshot -----------------------------------------------------------------

export interface SyncEvent {
  seq: number;
  type: string;
  conversation_id?: number;
  message_id?: number;
  payload: Record<string, unknown>;
}

export interface Delta {
  cursor: string;
  events: SyncEvent[];
  more: boolean;
  reset?: boolean;
  reason?: string;
}

/** `GET /api/sync/snapshot` as the owner. */
export async function snapshotOf(owner: Owner): Promise<{ epoch: string; as_of_seq: number; cursor: string }> {
  const res = await owner.client.get("/api/sync/snapshot");
  if (res.status !== 200) throw new Error(`GET /api/sync/snapshot: HTTP ${res.status} ${res.text}`);
  return res.json();
}

/** `GET /api/sync?cursor=` as the owner: the raw answer. */
export function syncRaw(owner: Owner, cursor: string, wait?: number) {
  return owner.client.get(`/api/sync?cursor=${encodeURIComponent(cursor)}${wait ? `&wait=${wait}` : ""}`);
}

/** `GET /api/sync?cursor=` as the owner; it must answer 200. */
export async function deltaFrom(owner: Owner, cursor: string, wait?: number): Promise<Delta> {
  const res = await syncRaw(owner, cursor, wait);
  if (res.status !== 200) throw new Error(`GET /api/sync?cursor=${cursor}: HTTP ${res.status} ${res.text}`);
  return res.json();
}

// ---- a raw GET that keeps the bytes (the wire is what the compression scenario measures) -------------------

export interface RawAnswer {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

/** One GET with the client's cookie and the given extra headers; the body is not decoded. */
export function rawGet(target: Target, client: Client, path: string, headers: Record<string, string> = {}): Promise<RawAnswer> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { method: "GET", path, host: "127.0.0.1", port: target.tcpPort, agent: false, headers: { Host: `${target.host}:${target.tcpPort}`, Cookie: client.cookieHeader(), ...headers } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const body = Buffer.concat(chunks);
          record(`HTTP GET ${path} (${headers["Accept-Encoding"] ?? "no encoding"})`, `content-encoding=${res.headers["content-encoding"] ?? "none"} wire=${body.length} bytes`, "", `status=${res.statusCode}`);
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body });
        });
        res.on("error", reject);
      },
    );
    req.setTimeout(10_000, () => req.destroy(new Error(`GET ${path}: no answer in 10 s`)));
    req.on("error", reject);
    req.end();
  });
}

// ---- the test hook that fills a conversation ----------------------------------------------------------------

/** `POST /__test/seed-messages`: write `count` messages of the owner into a conversation in one transaction (testhooks build). */
export async function seedMessages(srv: ServerHandle, conversation: number, count: number): Promise<void> {
  const res = await send(srv.target, "POST", "/__test/seed-messages", { json: { conversation_id: conversation, count }, timeoutMs: 280_000 });
  if (res.status !== 200) throw new Error(`POST /__test/seed-messages: HTTP ${res.status} ${res.text}`);
}

// ---- the lossy profile --------------------------------------------------------------------------------------

/**
 * The lossy profile of design §12.3: 400 ms round trip and 400 kbps both ways, by the browser's own network emulation. The
 * emulation slows each request but not an event stream that is already open, so a scenario that follows the stream also goes
 * through `stallProxy(target, LOSSY_STREAM_DELAY_MS)`, which holds each piece of the stream back by one way of the round trip.
 * Loss shows up as the cuts and stalls each scenario makes on purpose (the CI box has no `tc netem`; the report says so).
 * Turn it on AFTER sign-in: the passkey step needs no throttling.
 */
export const LOSSY_STREAM_DELAY_MS = 200;

export async function lossy(context: BrowserContext, page: Page): Promise<CDPSession> {
  const cdp = await context.newCDPSession(page);
  await cdp.send("Network.enable");
  await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 400, downloadThroughput: 50_000, uploadThroughput: 50_000 });
  return cdp;
}

// ---- the frames the page's stream received ----------------------------------------------------------------------

export interface SeenFrame {
  event: string;
  /** The SSE id, "<epoch>:<seq>". */
  id: string;
  /** `prev_seq_for_you` of the frame. */
  prev: number | null;
}

/** Keep every named frame the page's EventSource receives in `window.__frames`. Call before the page loads. */
export async function watchFrames(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    const Native = window.EventSource;
    if (!Native) return;
    (window as any).__frames = [];
    (window as any).EventSource = class extends Native {
      constructor(url: string | URL, init?: EventSourceInit) {
        super(url, init);
        for (const name of ["message.created", "read.moved", "conversation.created"]) {
          this.addEventListener(name, (e) => {
            const m = e as MessageEvent<string>;
            let prev: number | null = null;
            try {
              prev = JSON.parse(m.data).prev_seq_for_you ?? null;
            } catch {
              /* a frame that is not JSON is recorded without prev */
            }
            (window as any).__frames.push({ event: name, id: m.lastEventId, prev });
          });
        }
      }
    };
  });
}

/** The frames recorded by `watchFrames`. */
export function framesOf(page: Page): Promise<SeenFrame[]> {
  return page.evaluate(() => (window as any).__frames ?? []);
}

// ---- a proxy between the browser and the server that can stop reading and cut the event stream ----------------

export interface StreamRecord {
  /** The request's Last-Event-ID header, if the browser sent one. */
  lastEventId: string | undefined;
  /** Event names in order; the data is kept for `reset` only. */
  events: { name: string; data?: string }[];
  closed: boolean;
}

export interface StallProxy {
  /** `http://localhost:<port>`: the page opens this. */
  url: string;
  streams: StreamRecord[];
  /** Stop reading what the server sends on the event streams (a phone that froze). */
  stall(): void;
  resume(): void;
  /** Break every open event stream and hold new ones until `release`. */
  cut(): void;
  release(): void;
  close(): Promise<void>;
}

/**
 * A proxy in front of a TCP server. It makes the Host and Origin the server's wall expects, passes everything through, and
 * treats `/api/stream` specially: it parses the stream into `streams`, delays it by `streamDelayMs`, can stop reading it, and can cut it.
 */
export async function stallProxy(target: Target, streamDelayMs = 0): Promise<StallProxy> {
  if (target.tcpPort === undefined) throw new Error("stallProxy: the target must be a TCP listener");
  const streams: StreamRecord[] = [];
  const open = new Set<{ up: http.IncomingMessage; down: http.ServerResponse }>();
  const waiting: (() => void)[] = [];
  let stalled = false;
  let held = false;
  let proxyOrigin = "";

  const server = http.createServer((req, res) => {
    const isStream = (req.url ?? "").startsWith("/api/stream");
    const forward = () => {
      const headers = { ...req.headers, host: `${target.host}:${target.tcpPort}` };
      if (headers.origin) headers.origin = target.origin;
      if (headers.referer) headers.referer = headers.referer.replace(proxyOrigin, target.origin);
      const up = http.request({ host: "127.0.0.1", port: target.tcpPort, method: req.method, path: req.url, headers, agent: false }, (ur) => {
        res.writeHead(ur.statusCode ?? 502, ur.headers);
        if (!isStream) {
          ur.pipe(res);
          return;
        }
        const rec: StreamRecord = { lastEventId: req.headers["last-event-id"] as string | undefined, events: [], closed: false };
        streams.push(rec);
        const pair = { up: ur, down: res };
        open.add(pair);
        if (stalled) ur.pause();
        let buf = "";
        ur.on("data", (chunk: Buffer) => {
          buf += chunk.toString("utf8");
          for (let i = buf.indexOf("\n\n"); i >= 0; i = buf.indexOf("\n\n")) {
            const block = buf.slice(0, i);
            buf = buf.slice(i + 2);
            const name = /^event: (.+)$/m.exec(block)?.[1];
            if (name) rec.events.push({ name, ...(name === "reset" ? { data: /^data: (.+)$/m.exec(block)?.[1] ?? "" } : {}) });
          }
          if (streamDelayMs) setTimeout(() => res.write(chunk), streamDelayMs); // one timer length for every piece keeps their order
          else res.write(chunk);
        });
        ur.on("end", () => {
          rec.closed = true;
          open.delete(pair);
          setTimeout(() => res.end(), streamDelayMs);
        });
        ur.on("error", () => {
          rec.closed = true;
          open.delete(pair);
          res.destroy();
        });
      });
      up.on("error", () => req.socket.destroy());
      req.pipe(up);
    };
    if (isStream && held) waiting.push(forward);
    else forward();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = (server.address() as AddressInfo).port;
  proxyOrigin = `http://localhost:${port}`;
  return {
    url: proxyOrigin,
    streams,
    stall: () => {
      stalled = true;
      for (const { up } of open) up.pause();
    },
    resume: () => {
      stalled = false;
      for (const { up } of open) up.resume();
    },
    cut: () => {
      held = true;
      for (const { up, down } of open) {
        up.destroy();
        down.destroy();
      }
    },
    release: () => {
      held = false;
      for (const go of waiting.splice(0)) go();
    },
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      record(`stall proxy ${proxyOrigin} -> ${target.host}:${target.tcpPort}`, streams.map((s, i) => `stream ${i}: ${s.events.length} events, closed=${s.closed}`).join("\n"), "", "closed");
    },
  };
}

// ---- scenarios that wait for another work package ------------------------------------------------------------------

/**
 * A scenario whose test is written but cannot pass until the work package named in `needs` lands. It registers nothing,
 * so the parity gate sees no binding and the spec keeps its @unimplemented tag. `CONVOZ_RUN_DEFERRED=1` runs it to see what is missing.
 */
export function deferred(title: string, needs: string, opts: { tag: string[] }, fn: Parameters<typeof scenario>[2]): void {
  if (process.env.CONVOZ_RUN_DEFERRED === "1") scenario(`${title} [needs ${needs}]`, opts, fn);
}
