import { chatWorld, createConversation, startSession } from "./chat.ts";
import type { ServerHandle, ServerOptions } from "./fixtures.ts";

/**
 * Helpers of the "left over" scenarios (tests/*.left.spec.ts): the inbox rules that no earlier work package bound, the workspace
 * defaults, the machine key recovery, the platform contracts and the agent profile rules.
 */

type Server = (o?: ServerOptions) => Promise<ServerHandle>;

/**
 * Background of inbox.feature: a fresh server with owner "drew", machine "box-2" logged in with "devtool" and "docs",
 * conversation 41 "Ship search filters" with both, and sessions "s1" and "s2" of "devtool" on "box-2".
 * `plaintext` is the encryption-off build, so a scenario can read the data file.
 */
export async function inboxWorld(server: Server, o: { plaintext?: boolean } = {}) {
  const w = await chatWorld(server, { agents: ["devtool", "docs"], ...(o.plaintext ? { env: { CONVOZ_TEST_PLAINTEXT: "1" } } : {}) });
  const conv = await createConversation(w.owner, { title: "Ship search filters", participants: ["devtool", "docs"] });
  const s1 = await startSession(w.box, "devtool", "s1");
  const s2 = await startSession(w.box, "devtool", "s2");
  return { w, conv, s1, s2 };
}

export type InboxWorld = Awaited<ReturnType<typeof inboxWorld>>;

export const DAY_MS = 86_400_000;
export const HOUR_MS = 3_600_000;

// ---- a counting forwarder that can answer the first requests of one route itself --------------------------------------

import http from "node:http";
import type { AddressInfo } from "node:net";
import type { Target } from "./http.ts";
import { record } from "./transcript.ts";

export interface Forwarded {
  method: string;
  path: string;
  /** The status the client got. */
  status: number;
  /** When the request arrived, ms since the epoch. */
  at: number;
}

export interface Forwarder {
  /** `http://127.0.0.1:<port>`: the server address of a machine. */
  url: string;
  log: Forwarded[];
  /** The log entries of one route (path without query). */
  entries(method: string, path: string): Forwarded[];
  close(): Promise<void>;
}

/**
 * A forwarder in front of a TCP server that logs every request it sees. With `answer` it replies to the first `times` requests of that
 * route by itself (a status and headers) and never passes them on, as a server that is busy would.
 */
export async function forwarder(
  target: Target,
  answer?: { method: string; path: string; status: number; headers?: Record<string, string>; times: number },
): Promise<Forwarder> {
  if (target.tcpPort === undefined) throw new Error("forwarder: the target must be a TCP listener");
  const log: Forwarded[] = [];
  let answered = 0;
  const server = http.createServer((req, res) => {
    const at = Date.now();
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const route = (req.url ?? "").split("?")[0] ?? "";
      if (answer && req.method === answer.method && route === answer.path && answered < answer.times) {
        answered += 1;
        log.push({ method: req.method ?? "", path: route, status: answer.status, at });
        res.writeHead(answer.status, { "Content-Type": "application/json", ...(answer.headers ?? {}) });
        res.end(JSON.stringify({ error: { code: "rate_limited", message: "Too many tries." } }));
        return;
      }
      const up = http.request(
        { host: "127.0.0.1", port: target.tcpPort, method: req.method, path: req.url, agent: false, headers: { ...req.headers, host: `${target.host}:${target.tcpPort}`, connection: "close" } },
        (ur) => {
          log.push({ method: req.method ?? "", path: route, status: ur.statusCode ?? 502, at });
          res.writeHead(ur.statusCode ?? 502, ur.headers);
          ur.pipe(res);
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
    entries: (method, path) => log.filter((e) => e.method === method && e.path === path),
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      record(`forwarder 127.0.0.1:${port} -> ${target.host}:${target.tcpPort}`, log.map((e) => `${e.method} ${e.path} ${e.status}`).join("\n"), "", "closed");
    },
  };
}
