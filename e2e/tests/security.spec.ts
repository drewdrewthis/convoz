import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fakeTailscale, funnelConfig } from "../lib/fake-tailscale.ts";
import { Client, send } from "../lib/http.ts";
import { listeners } from "../lib/listeners.ts";
import { API_HOST, apiServer, bootstrapOwner, freePort, tmpDir } from "../lib/owner.ts";
import { expect, scenario } from "../lib/scenario.ts";

const mode = (p: string) => fs.statSync(p).mode & 0o777;

scenario("The server listens only on its socket or loopback", { tag: ["@api"] }, async ({ server, serveCli }) => {
  // When the server has started on loopback TCP
  const tcp = await server(apiServer());
  const onTcp = listeners(tcp.pid);

  // Then the only listening addresses of the server process are 127.0.0.1 (plus its admin socket)
  expect(onTcp.tcp.length).toBeGreaterThan(0);
  expect(onTcp.tcp.filter((a) => !a.startsWith("127.0.0.1:"))).toEqual([]);
  expect(onTcp.udp).toEqual([]);
  expect(onTcp.unix).toEqual([tcp.adminSocket]);

  // And with a unix listener it is its two sockets and nothing on the network, both mode 0600
  const sock = await server(apiServer({ listen: "unix", dataDir: tmpDir() }));
  const onUnix = listeners(sock.pid);
  expect(onUnix.tcp).toEqual([]);
  expect(onUnix.udp).toEqual([]);
  expect([...onUnix.unix].sort()).toEqual([sock.unixPath!, sock.adminSocket!].sort());
  expect(mode(sock.unixPath!)).toBe(0o600);
  expect(mode(sock.adminSocket!)).toBe(0o600);
  expect(sock.ready.listen).toBe(`unix://${sock.unixPath}`);
  expect(sock.ready.admin).toBe(`unix://${sock.adminSocket}`);

  // And the server will not listen anywhere else (exit 13), nor without its name (exit 13)
  for (const addr of ["0.0.0.0:0", "192.0.2.10:0", "[::]:0"]) {
    const res = await serveCli({ listenAddr: addr, dataDir: tmpDir() });
    expect(res.code, `${addr}: ${res.stderr}`).toBe(13);
    expect(res.stderr).toMatch(/not loopback/);
  }
  const noHost = await serveCli({ noHost: true, dataDir: tmpDir() });
  expect(noHost.code).toBe(13);
  expect(noHost.stderr).toMatch(/--host is required/);

  // And a unix path longer than 107 bytes is a usage error (exit 2)
  const long = await serveCli({ listenAddr: `unix://${tmpDir()}/${"a".repeat(110)}.sock`, dataDir: tmpDir() });
  expect(long.code).toBe(2);

  // And an admin socket the server cannot secure is exit 14: a parent others can write, or a live socket already there
  const open = tmpDir("convoz-open-");
  fs.chmodSync(open, 0o777);
  const loose = await serveCli({ adminSocket: path.join(open, "admin.sock"), dataDir: tmpDir() });
  expect(loose.code).toBe(14);
  expect(loose.stderr).toMatch(/admin socket/);
  const held = path.join(tmpDir("convoz-held-"), "admin.sock");
  const holder = net.createServer();
  await new Promise<void>((resolve) => holder.listen(held, resolve));
  try {
    const live = await serveCli({ adminSocket: held, dataDir: tmpDir() });
    expect(live.code).toBe(14);
    expect(live.stderr).toMatch(/admin socket/);
  } finally {
    holder.close();
  }
});

scenario("The server refuses to start when funnel is on", { tag: ["@cli"] }, async ({ server, serveCli }) => {
  const port = await freePort();
  const sockPath = path.join(tmpDir("convoz-fs-"), "http.sock");
  const hostPort = `${API_HOST}:443`;
  const ts = fakeTailscale();
  const base = { host: API_HOST, adminSocket: true, tailscale: { bin: ts.bin } } as const;

  // Given a fake tailscale command that reports funnel on for the server port
  ts.set({ serve: funnelConfig(hostPort, `http://127.0.0.1:${port}`) });

  // When "convoz serve" starts
  const tcp = await serveCli({ ...base, listenAddr: `127.0.0.1:${port}`, dataDir: tmpDir() });

  // Then it exits non-zero (13) with a message that funnel must be off
  expect(tcp.code, tcp.stderr).toBe(13);
  expect(tcp.stderr).toMatch(/funnel must be off/i);
  expect(ts.calls().some((c) => c.includes("status") && c.includes("--json"))).toBe(true);

  // And the same holds for a unix listener, and for funnel set in a foreground session
  ts.set({ serve: funnelConfig(hostPort, `unix:${sockPath}`) });
  const unix = await serveCli({ ...base, listenAddr: `unix://${sockPath}`, dataDir: tmpDir() });
  expect(unix.code, unix.stderr).toBe(13);
  ts.set({ serve: funnelConfig(hostPort, `http://127.0.0.1:${port}`, { where: "foreground" }) });
  const fg = await serveCli({ ...base, listenAddr: `127.0.0.1:${port}`, dataDir: tmpDir() });
  expect(fg.code, fg.stderr).toBe(13);

  // And a tailscale that cannot be read, or is missing, also stops the start under the default check
  ts.set({ serveExit: 1, serveStderr: "TESTONLY: tailscaled is not running" });
  const unreadable = await serveCli({ ...base, listenAddr: `127.0.0.1:${port}`, dataDir: tmpDir() });
  expect(unreadable.code).toBe(13);
  const missing = await serveCli({ ...base, tailscale: { bin: "/nonexistent/TESTONLY/tailscale" }, listenAddr: `127.0.0.1:${port}`, dataDir: tmpDir() });
  expect(missing.code).toBe(13);

  // Controls: funnel on for another port, funnel off for ours, and --tailscale off, all start
  ts.set({ serve: funnelConfig(hostPort, `http://127.0.0.1:${port + 1}`) });
  const other = await server({ ...base, listenAddr: `127.0.0.1:${port}`, dataDir: tmpDir() });
  await other.stop();
  ts.set({ serve: funnelConfig(hostPort, `http://127.0.0.1:${port}`, { allowFunnel: false }) });
  const off = await server({ ...base, listenAddr: `127.0.0.1:${port}`, dataDir: tmpDir() });
  await off.stop();
  ts.set({ serve: funnelConfig(hostPort, `http://127.0.0.1:${port}`) });
  const skipped = await server({ ...base, tailscale: { bin: ts.bin, mode: "off" }, listenAddr: `127.0.0.1:${port}`, dataDir: tmpDir() });
  expect(skipped.tcpPort).toBe(port);
});

scenario("An unknown Host is refused before auth", { tag: ["@api"] }, async ({ server }) => {
  const srv = await server(apiServer());
  const owner = await bootstrapOwner(srv);
  const cookie = owner.client.cookieHeader();
  const port = srv.tcpPort!;

  // Control: the right Host with the valid device cookie is served
  expect((await owner.client.get("/api/me")).status).toBe(200);

  // When a request with Host "evil.example:7788" and a valid device cookie arrives
  const evil = await owner.client.get("/api/me", { hostHeader: "evil.example:7788" });

  // Then the server answers 421 (also without a cookie, so it is not auth that refuses it)
  expect(evil.status).toBe(421);
  expect((await new Client(srv.target).get("/api/me", { hostHeader: "evil.example:7788" })).status).toBe(421);
  for (const h of [`${API_HOST}:${port + 1}`, `127.0.0.1:${port}`, `localhost:${port}`, "convoz.evil.ts.net"]) {
    expect((await new Client(srv.target).get("/api/version", { hostHeader: h, cookie })).status, h).toBe(421);
  }

  // And behind tailscale serve the forwarded name is checked: Host stays "localhost", X-Forwarded-Host must be the --host name
  const sock = await server(apiServer({ listen: "unix", dataDir: tmpDir() }));
  expect((await send(sock.target, "GET", "/api/version")).status).toBe(200);
  expect((await send(sock.target, "GET", "/api/version", { forwardedHost: "evil.example" })).status).toBe(421);
  expect((await send(sock.target, "GET", "/api/version", { forwardedHost: null })).status).toBe(421);
  expect((await send(sock.target, "GET", "/api/version", { hostHeader: "evil.example" })).status).toBe(421);
});

scenario("Tailscale headers from a non-serve peer change nothing", { tag: ["@api"] }, async ({ server }) => {
  const forged = { "Tailscale-User-Login": "drew@example.com", "Tailscale-User-Name": "Drew", "Tailscale-User-Profile-Pic": "https://example.com/TESTONLY.png" };
  const tcp = await server(apiServer());
  await bootstrapOwner(tcp);

  // When a request without credentials carries "Tailscale-User-Login: drew@example.com"
  const anon = await new Client(tcp.target).get("/api/me", { headers: forged });

  // Then the server answers 401
  expect(anon.status).toBe(401);

  // And forged "X-Forwarded-For" values over TCP do not move the per-source rate-limit bucket:
  // public sign-in options allow 20 per source per minute (then 429 rate_limited); every forged address is the same TCP source.
  const statuses: number[] = [];
  for (let i = 1; i <= 21; i++) {
    const res = await new Client(tcp.target).post("/api/auth/passkey/login/options", {}, { headers: { "X-Forwarded-For": `198.51.100.${i}` } });
    statuses.push(res.status);
  }
  expect(statuses.slice(0, 20).every((s) => s === 200)).toBe(true);
  expect(statuses[20]).toBe(429);

  // And behind the unix listener the header is trusted: a source of its own has a bucket of its own
  const sock = await server(apiServer({ listen: "unix", dataDir: tmpDir() }));
  await bootstrapOwner(sock);
  expect((await new Client(sock.target).get("/api/me", { headers: forged })).status).toBe(401); // user headers are display only
  const same: number[] = [];
  for (let i = 1; i <= 21; i++) {
    same.push((await new Client(sock.target).post("/api/auth/passkey/login/options", {}, { headers: { "X-Forwarded-For": "203.0.113.9" } })).status);
  }
  expect(same.slice(0, 20).every((s) => s === 200)).toBe(true);
  expect(same[20]).toBe(429);
  expect((await new Client(sock.target).post("/api/auth/passkey/login/options", {}, { headers: { "X-Forwarded-For": "203.0.113.10" } })).status).toBe(200);

  // And a request carrying "Tailscale-Funnel-Request" is refused with 403 on either listener
  expect((await new Client(tcp.target).get("/api/version")).status).toBe(200);
  expect((await new Client(tcp.target).get("/api/version", { headers: { "Tailscale-Funnel-Request": "?1" } })).status).toBe(403);
  expect((await new Client(sock.target).get("/api/version", { headers: { "Tailscale-Funnel-Request": "?1" } })).status).toBe(403);
});

scenario("A credential in a query string is refused and never logged", { tag: ["@api"] }, async ({ server }) => {
  const srv = await server(apiServer());
  const client = new Client(srv.target);

  // When a request asks for "/api/me?key=cvz_m_TESTONLY0000000000000000"
  const res = await client.get("/api/me?key=cvz_m_TESTONLY0000000000000000");

  // Then the server answers 400 (credential_in_url), on public routes too
  expect(res.status).toBe(400);
  expect(res.json().error.code).toBe("credential_in_url");
  expect((await client.get("/api/version?x=cvz_s_TESTONLY1111111111111111")).status).toBe(400);
  expect((await client.post("/api/auth/recovery?c=cvz_b_TESTONLY2222222222222222", { code: "x" })).status).toBe(400);
  expect((await client.get("/api/version?harmless=1")).status).toBe(200);

  // And the server log contains no "cvz_" string (the request log names method and path, never the query)
  await expect.poll(() => srv.log(), { message: "request log has the path" }).toContain("/api/me");
  expect(srv.log()).not.toContain("cvz_");
  expect(srv.log()).not.toContain("key=");
});

scenario("The Authorization header is never logged", { tag: ["@api"] }, async ({ server }) => {
  const srv = await server(apiServer());

  // When 10 agent requests with fake leases are served
  const statuses: number[] = [];
  for (let i = 0; i < 10; i++) {
    const res = await new Client(srv.target).get("/api/me", { headers: { Authorization: `Bearer cvz_s_TESTONLYLEASE${i}aaaaaaaaaaaaaaaa` } });
    statuses.push(res.status);
  }
  expect(statuses.every((s) => s === 401)).toBe(true);

  // Then the server log contains no "Authorization" value and no "cvz_s_" string
  await expect.poll(() => srv.log(), { message: "request log has the path" }).toContain("/api/me");
  const log = srv.log();
  expect(log).not.toContain("cvz_s_");
  expect(log).not.toContain("TESTONLYLEASE");
  expect(log).not.toContain("Bearer");
});

scenario("Cookie writes need the exact Origin and the Convoz header", { tag: ["@api"] }, async ({ server }) => {
  const srv = await server(apiServer());
  const owner = await bootstrapOwner(srv);
  const route = "/api/auth/step-up/options";
  const body = { action: "passkey.add" };

  // Control: exact Origin, the Convoz header and JSON pass
  expect((await owner.client.post(route, body)).status).toBe(200);

  // When the owner's device cookie sends POST /api/auth/step-up/options with <headers>, Then the server answers 403
  const rows: [string, Parameters<Client["post"]>[2]][] = [
    ['Origin "https://evil.example"', { origin: "https://evil.example" }],
    ["no Origin header", { origin: null }],
    ['the right Origin but no "X-Convoz: 1" header', { noConvozHeader: true }],
  ];
  for (const [name, opts] of rows) {
    expect((await owner.client.post(route, body, opts)).status, name).toBe(403);
  }
});

scenario("Unknown request fields are refused", { tag: ["@api"] }, async ({ server }) => {
  const srv = await server(apiServer());
  const owner = await bootstrapOwner(srv);

  // When the owner sends POST /api/auth/step-up/options with an extra field "admin": true
  const res = await owner.client.post("/api/auth/step-up/options", { action: "passkey.add", admin: true });

  // Then the server answers 400 (invalid_request), on public routes too
  expect(res.status).toBe(400);
  expect(res.json().error.code).toBe("invalid_request");
  expect((await new Client(srv.target).post("/api/auth/recovery", { code: "TESTONLY-wrong", admin: true })).status).toBe(400);
  expect((await owner.client.post("/api/auth/step-up/options", { action: "passkey.add" })).status).toBe(200);
});
