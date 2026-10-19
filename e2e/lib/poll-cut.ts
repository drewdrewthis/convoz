import http from "node:http";
import type { AddressInfo } from "node:net";
import type { Target } from "./http.ts";
import { record } from "./transcript.ts";

/**
 * A keep-alive forwarder in front of a TCP server that loses the answer of one inbox poll ("A watch gets every item, even when two
 * arrive together or a poll is cut"). Once armed, the first poll whose answer carries an item reaches the server, so the server claims
 * the item, but the client gets not one byte of the answer: its connection is closed. A client that reused that connection sees no
 * error, because Go's HTTP client sends an idempotent GET again by itself on a reused connection that died before any byte came back.
 * Every other request passes unchanged. The log holds method, path, status and the number of items, never a body.
 */
export interface PollCutEntry {
  method: string;
  path: string;
  status: number;
  items: number;
  cut: boolean;
}

export interface PollCut {
  url: string;
  log: PollCutEntry[];
  /** Lose the answer of the next poll that carries an item. */
  arm(): void;
  /** Settles once an answer was lost. */
  cut: Promise<void>;
  close(): Promise<void>;
}

const INBOX = "/api/inbox";
/** Hop-by-hop headers of the server's answer: the client's connection to the forwarder is its own and stays open. */
const HOP = new Set(["connection", "keep-alive", "transfer-encoding"]);

export async function pollCut(target: Target): Promise<PollCut> {
  if (target.tcpPort === undefined) throw new Error("pollCut: the target must be a TCP listener");
  const log: PollCutEntry[] = [];
  let armed = false;
  let onCut = () => {};
  const cut = new Promise<void>((resolve) => (onCut = resolve));
  const server = http.createServer({ keepAlive: true }, (req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const route = (req.url ?? "").split("?")[0] ?? "";
      const { "accept-encoding": _plain, ...headers } = req.headers; // a plain answer, so the forwarder can count its items
      const up = http.request(
        { host: "127.0.0.1", port: target.tcpPort, method: req.method, path: req.url, agent: false, headers: { ...headers, host: `${target.host}:${target.tcpPort}`, connection: "close" } },
        (ur) => {
          const body: Buffer[] = [];
          ur.on("data", (c: Buffer) => body.push(c));
          ur.on("end", () => {
            const raw = Buffer.concat(body);
            const status = ur.statusCode ?? 502;
            const items = req.method === "GET" && route === INBOX && status === 200 ? itemCount(raw) : 0;
            const lose = armed && items > 0;
            log.push({ method: req.method ?? "", path: route, status, items, cut: lose });
            if (lose) {
              armed = false;
              req.socket.destroy();
              onCut();
              return;
            }
            const headers = Object.fromEntries(Object.entries(ur.headers).filter(([k]) => !HOP.has(k)));
            res.writeHead(status, { ...headers, "content-length": String(raw.length) });
            res.end(raw);
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
    arm: () => {
      armed = true;
    },
    cut,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      record(`poll cut 127.0.0.1:${port} -> ${target.host}:${target.tcpPort}`, log.map((e) => `${e.method} ${e.path} ${e.status} items ${e.items}${e.cut ? " cut" : ""}`).join("\n"), "", "closed");
    },
  };
}

function itemCount(raw: Buffer): number {
  try {
    const items = (JSON.parse(raw.toString("utf8")) as { items?: unknown[] }).items;
    return Array.isArray(items) ? items.length : 0;
  } catch {
    return 0;
  }
}
