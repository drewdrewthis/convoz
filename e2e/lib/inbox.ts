import http from "node:http";
import type { AddressInfo } from "node:net";
import type { ServerHandle } from "./fixtures.ts";
import { send, type Res, type Target } from "./http.ts";
import { bearer } from "./machines.ts";
import { record } from "./transcript.ts";
import { createConversation, ownerSays } from "./chat.ts";
import type { Owner } from "./owner.ts";

/**
 * Helpers of the inbox scenarios (inbox.wp6.spec.ts, sessions.wp6.spec.ts, security.wp6.spec.ts).
 * The routes they call are in the contract block at the top of chat-api.spec.ts, plus (S3):
 *   GET  /api/inbox?conv=C                         claims only the items of conversation C
 *   POST /api/inbox/claim {n, visibility?, conv?}   -> 200 {items} with claim tokens
 *   POST /api/inbox/ack   {items:[{id, claim_token}]} -> 200 {results}; a lost claim -> 409 claim_lost (+ results); no token -> 400
 * An item carries `mention_count` (how many of its messages mention the agent) and `deliveries` (how many times a claim handed it out).
 */

export interface Item {
  id: number;
  claim_token?: string;
  state: string;
  reason: string;
  count: number;
  mention_count?: number;
  deliveries: number;
  conversation: { id: number; title: string | null };
  message: { id: number; body: string };
}

/** `GET /api/inbox?<query>` with a lease. */
export function inboxApi(srv: ServerHandle, lease: string, query = ""): Promise<Res> {
  return send(srv.target, "GET", `/api/inbox${query ? `?${query}` : ""}`, bearer(lease));
}

/** The items of an inbox answer that must be 200. */
export async function itemsOf(res: Res): Promise<Item[]> {
  if (res.status !== 200) throw new Error(`inbox answered ${res.status}: ${res.text}`);
  return res.json().items as Item[];
}

/** `GET /api/inbox?peek=1`: the identity's ready and claimed items; nothing is claimed. */
export const peekApi = async (srv: ServerHandle, lease: string): Promise<Item[]> => itemsOf(await inboxApi(srv, lease, "peek=1"));

/** `POST /api/inbox/ack` with the given item refs. */
export function ackApi(srv: ServerHandle, lease: string, items: { id: number; claim_token?: string }[]): Promise<Res> {
  return send(srv.target, "POST", "/api/inbox/ack", { json: { items }, ...bearer(lease) });
}

/** `n` new conversations of the owner with the given agents, each holding one owner message `@<agent> <i>`. Returns the conversation ids. */
export async function conversationsWithMentions(owner: Owner, n: number, agent: string): Promise<number[]> {
  const out: number[] = [];
  for (let i = 1; i <= n; i++) {
    const conv = await createConversation(owner, { title: `Topic ${i}`, participants: [agent] });
    await ownerSays(owner, conv, `@${agent} item ${i}`);
    out.push(conv);
  }
  return out;
}

export interface ProxyEntry {
  path: string;
  status: number;
  /** Time from the request to the answer, ms. */
  ms: number;
  dropped: boolean;
}

export interface InboxProxy {
  /** `http://127.0.0.1:<port>`: pass it as the CLI's server. */
  url: string;
  log: ProxyEntry[];
  /** Number of answers it threw away. */
  drops(): number;
  close(): Promise<void>;
}

/**
 * A forwarder in front of the server that logs how long each `GET /api/inbox` took and, up to `maxDrops` times, throws away
 * the answer that delivers an item (a body with a "claim_token"): the server did the work, the client never hears of it.
 */
export async function inboxProxy(target: Target, o: { maxDrops?: number } = {}): Promise<InboxProxy> {
  if (target.tcpPort === undefined) throw new Error("inboxProxy: the target must be a TCP listener");
  const log: ProxyEntry[] = [];
  let dropped = 0;
  const server = http.createServer((req, res) => {
    const started = Date.now();
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const up = http.request(
        { host: "127.0.0.1", port: target.tcpPort, method: req.method, path: req.url, agent: false, headers: { ...req.headers, host: `${target.host}:${target.tcpPort}`, connection: "close" } },
        (ur) => {
          const out: Buffer[] = [];
          ur.on("data", (c: Buffer) => out.push(c));
          ur.on("end", () => {
            const body = Buffer.concat(out);
            const status = ur.statusCode ?? 502;
            const path = (req.url ?? "").split("?")[0] ?? "";
            const lose = req.method === "GET" && path === "/api/inbox" && status === 200 && body.includes('"claim_token"') && dropped < (o.maxDrops ?? 0);
            if (lose) dropped += 1;
            if (path === "/api/inbox") log.push({ path, status, ms: Date.now() - started, dropped: lose });
            if (lose) {
              req.socket.destroy();
              return;
            }
            res.writeHead(status, ur.headers);
            res.end(body);
          });
        },
      );
      up.on("error", () => req.socket.destroy());
      up.end(Buffer.concat(chunks));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    log,
    drops: () => dropped,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      record(`inbox proxy 127.0.0.1:${port}`, log.map((e) => `GET ${e.path} ${e.status} ${e.ms}ms${e.dropped ? " answer dropped" : ""}`).join("\n"), "", "closed");
    },
  };
}
