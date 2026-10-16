import crypto from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { Target } from "./http.ts";
import { record } from "./transcript.ts";

/**
 * A forwarder in front of a TCP server that loses one response (S1 plan §4.5): it passes the request on,
 * reads the real answer, and when the answer is the `nth` 2xx for `method path` it destroys the client socket
 * instead of sending it. The server has done the work; the client never hears about it.
 *
 * The log holds method, path, status and a short SHA-256 of the request body, never a body, so two polls with
 * the same device code show the same `bodyHash` without the code appearing anywhere.
 */
export interface ProxyEntry {
  method: string;
  path: string;
  status: number;
  /** First 12 hex of SHA-256 over the request body ("" hashes as e3b0c44298fc). */
  bodyHash: string;
  /** True for the one response the proxy swallowed. */
  dropped: boolean;
}

export interface FaultRule {
  method: string;
  /** Path without query. */
  path: string;
  /** Swallow the response of the nth 2xx answer for this route (1 = the first). */
  nth: number;
}

export interface FaultProxy {
  /** `http://127.0.0.1:<port>`; pass it as the CLI's `--server` (loopback http is allowed). */
  url: string;
  port: number;
  log: ProxyEntry[];
  /** Entries for one route, in order. */
  entries(method: string, path: string): ProxyEntry[];
  /** Stop listening, drop open connections and write the log into the test transcript. */
  close(): Promise<void>;
}

const sha = (b: Buffer): string => crypto.createHash("sha256").update(b).digest("hex").slice(0, 12);

/** Start a proxy in front of `target` (a TCP server). The upstream sees Host `<target.host>:<port>`, which its wall accepts. */
export async function faultProxy(target: Target, rule: FaultRule): Promise<FaultProxy> {
  if (target.tcpPort === undefined) throw new Error("faultProxy: the target must be a TCP listener");
  const log: ProxyEntry[] = [];
  let hits = 0;
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      const up = http.request(
        {
          host: "127.0.0.1",
          port: target.tcpPort,
          method: req.method,
          path: req.url,
          agent: false,
          headers: { ...req.headers, host: `${target.host}:${target.tcpPort}`, connection: "close" },
        },
        (ur) => {
          const out: Buffer[] = [];
          ur.on("data", (c: Buffer) => out.push(c));
          ur.on("end", () => {
            const status = ur.statusCode ?? 502;
            const route = (req.url ?? "").split("?")[0];
            const hit = status >= 200 && status < 300 && req.method === rule.method && route === rule.path;
            if (hit) hits += 1;
            const dropped = hit && hits === rule.nth;
            log.push({ method: req.method ?? "", path: route ?? "", status, bodyHash: sha(body), dropped });
            if (dropped) {
              req.socket.destroy();
              return;
            }
            res.writeHead(status, ur.headers);
            res.end(Buffer.concat(out));
          });
        },
      );
      up.on("error", () => req.socket.destroy());
      up.end(body);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    log,
    entries: (method, path) => log.filter((e) => e.method === method && e.path === path),
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      record(
        `fault proxy 127.0.0.1:${port} -> ${target.host}:${target.tcpPort}`,
        log.map((e) => `${e.method} ${e.path} ${e.status} body#${e.bodyHash}${e.dropped ? " response dropped" : ""}`).join("\n"),
        "",
        "closed",
      );
    },
  };
}
