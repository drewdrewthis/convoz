import http from "node:http";
import type { AddressInfo } from "node:net";
import type { Target } from "./http.ts";
import { record } from "./transcript.ts";

/**
 * A forwarder in front of a TCP server that cuts one upload in the middle (the dropped connection of "A dropped connection mid-upload
 * resumes and posts once"). The first PATCH of an upload reaches the server only up to `afterBytes` of its body; then the proxy closes
 * both ends. The server keeps what came (whole segments) and the client sees a lost connection. Every other request passes unchanged.
 * Like fault-proxy.ts, the log holds method, path and status, never a body.
 */
export interface CutEntry {
  method: string;
  path: string;
  /** 0 for the request that was cut. */
  status: number;
  /** The Upload-Offset the request carried ("" when it had none). */
  offset: string;
  cut: boolean;
}

export interface CutProxy {
  url: string;
  log: CutEntry[];
  close(): Promise<void>;
}

/** Time the server gets to store the part that arrived before the client hears the connection is gone. */
const SETTLE_MS = 600;

export async function cutProxy(target: Target, afterBytes: number): Promise<CutProxy> {
  if (target.tcpPort === undefined) throw new Error("cutProxy: the target must be a TCP listener");
  const log: CutEntry[] = [];
  let cutDone = false;
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      const route = (req.url ?? "").split("?")[0] ?? "";
      const offset = String(req.headers["upload-offset"] ?? "");
      const cutThis = !cutDone && req.method === "PATCH" && route.startsWith("/api/uploads/") && body.length > afterBytes;
      const up = http.request(
        { host: "127.0.0.1", port: target.tcpPort, method: req.method, path: req.url, agent: false, headers: { ...req.headers, host: `${target.host}:${target.tcpPort}`, connection: "close" } },
        (ur) => {
          log.push({ method: req.method ?? "", path: route, status: ur.statusCode ?? 502, offset, cut: false });
          res.writeHead(ur.statusCode ?? 502, ur.headers);
          ur.pipe(res);
        },
      );
      up.on("error", () => req.socket.destroy());
      if (cutThis) {
        cutDone = true;
        log.push({ method: req.method ?? "", path: route, status: 0, offset, cut: true });
        up.write(body.subarray(0, afterBytes));
        setTimeout(() => {
          up.destroy();
          setTimeout(() => req.socket.destroy(), SETTLE_MS);
        }, 100);
        return;
      }
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
    log,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      record(`cut proxy 127.0.0.1:${port} -> ${target.host}:${target.tcpPort}`, log.map((e) => `${e.method} ${e.path} ${e.status} offset ${e.offset}${e.cut ? " cut" : ""}`).join("\n"), "", "closed");
    },
  };
}
