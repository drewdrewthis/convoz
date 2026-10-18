import { spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import http2 from "node:http2";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";

/*
 * A TLS front that speaks HTTP/2 only, in front of a plain-HTTP test server: what `tailscale serve` is to prod (TLS, HTTP/2 to the
 * browser, HTTP/1.1 to the server behind it). The client budget scenario loads the app through it, because the 6-connection limit of
 * HTTP/1.1 makes a request wave cost a whole round trip on a slow link, and prod does not pay that.
 * The certificate is a throwaway self-signed TESTONLY one, made by openssl by argv (never a shell) in a scratch dir; the browser
 * ignores HTTPS errors. ALPN offers only "h2" (allowHTTP1 false), so a client that cannot speak it fails to connect instead of
 * silently measuring HTTP/1.1.
 */

export interface H2Front {
  /** `https://localhost:<port>`: the origin the browser opens. */
  origin: string;
  close(): Promise<void>;
}

const HOP_BY_HOP = new Set(["connection", "keep-alive", "proxy-connection", "transfer-encoding", "upgrade"]);

/** Listen on a free loopback port and forward every request to `127.0.0.1:upstreamPort`. */
export async function h2Front(upstreamPort: number): Promise<H2Front> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "convoz-h2front-"));
  const key = path.join(dir, "key.TESTONLY.pem");
  const cert = path.join(dir, "cert.TESTONLY.pem");
  const made = spawnSync(
    "openssl",
    ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-days", "2", "-keyout", key, "-out", cert, "-subj", "/CN=TESTONLY localhost", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1"],
    { encoding: "utf8", timeout: 20_000, shell: false },
  );
  if (made.status !== 0) throw new Error(`h2Front: openssl failed: ${made.stderr}`);

  const upstream = new http.Agent({ keepAlive: true });
  let origin = "";
  const server = http2.createSecureServer({ key: fs.readFileSync(key), cert: fs.readFileSync(cert), allowHTTP1: false }, (req, res) => {
    const headers: http.OutgoingHttpHeaders = {};
    for (const [name, value] of Object.entries(req.headers)) if (!name.startsWith(":") && !HOP_BY_HOP.has(name)) headers[name] = value;
    // The server's wall wants its own Host and Origin (it serves http://localhost:<port>); tailscale serve rewrites them the same way.
    headers.host = `localhost:${upstreamPort}`;
    if (headers.origin === origin) headers.origin = `http://localhost:${upstreamPort}`;
    const up = http.request({ host: "127.0.0.1", port: upstreamPort, method: req.method, path: req.url, headers, agent: upstream }, (answer) => {
      const out: http.OutgoingHttpHeaders = {};
      for (const [name, value] of Object.entries(answer.headers)) if (!HOP_BY_HOP.has(name)) out[name] = value;
      res.writeHead(answer.statusCode ?? 502, out);
      answer.pipe(res);
    });
    up.on("error", () => res.destroy());
    res.on("close", () => up.destroy());
    req.pipe(up);
  });
  const sessions = new Set<http2.ServerHttp2Session>();
  server.on("session", (s) => {
    sessions.add(s);
    s.once("close", () => sessions.delete(s));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  origin = `https://localhost:${(server.address() as AddressInfo).port}`;
  return {
    origin,
    close: () => {
      upstream.destroy();
      for (const s of sessions) s.destroy();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
