import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test as base, type BrowserContext, type TestInfo } from "@playwright/test";
import { installCeremonyGuard, type CeremonyGuard } from "./ceremony-guard.ts";
import { send, type Target } from "./http.ts";
import { baseEnv, repoRoot, run, type RunResult } from "./run.ts";
import { beginTranscript, endTranscript, record, track } from "./transcript.ts";

/** The binary under test. The default is the `-tags testhooks` build. */
export const convozBin = path.resolve(
  repoRoot,
  process.env.CONVOZ_BIN ?? "apps/convoz/bin/convoz-test",
);

export interface ConvozOptions {
  env?: Record<string, string>;
  timeoutMs?: number;
}
export type ConvozRun = (argv: string[], opts?: ConvozOptions) => Promise<RunResult>;

export interface TailscaleOptions {
  /** `--tailscale-bin`; default (when only `mode` is set): the server's own default, `tailscale`. */
  bin?: string;
  /** `--tailscale check|off`. Default: omitted when `bin` is set (the server default is check), else `off`. */
  mode?: "check" | "off";
}

export interface ServerOptions {
  /** Data dir to serve; default: the dataDir fixture. */
  dataDir?: string;
  /** KEK file to pass; `null` passes none. Default: the kekFile fixture. */
  kek?: string | null;
  /** Extra env (after CONVOZ_TEST_ADMIN=1). */
  env?: Record<string, string>;
  extraArgs?: string[];
  /** `--host`. Default `localhost`. Origin is `http://localhost:<port>` for `localhost`, else `https://<host>`. */
  host?: string;
  /** Omit `--host` (the wall must refuse: exit 13). */
  noHost?: boolean;
  /** `tcp` (default): `--listen 127.0.0.1:0`. `unix`: `--listen unix://<scratch>/http.sock`. */
  listen?: "tcp" | "unix";
  /** Raw `--listen` value; wins over `listen`. */
  listenAddr?: string;
  /** `true`: `--admin-socket <scratch>/admin.sock`. A string is used as the path. Default: no admin socket. */
  adminSocket?: boolean | string;
  /** Tailscale flags. Default: `--tailscale off`. */
  tailscale?: TailscaleOptions;
  /** `serveCli` only: bound for a server that should exit by itself. Default 8000. */
  timeoutMs?: number;
}

export interface ServerHandle {
  /** `http://127.0.0.1:<port>` (TCP listener); `http://localhost` for a unix listener (not reachable by URL). */
  url: string;
  /** The `--host` value. */
  host: string;
  /** The exact Origin a browser on this server sends. */
  origin: string;
  /** TCP port, when the listener is TCP. */
  tcpPort?: number;
  /** Socket path, when the listener is a unix socket. */
  unixPath?: string;
  /** Admin socket path, when `--admin-socket` was passed. */
  adminSocket?: string;
  /** For the HTTP helpers in http.ts. */
  target: Target;
  /** The ready file as the server wrote it. */
  ready: { listen: string; admin?: string; pid: number };
  pid: number;
  /** Combined stdout and stderr so far. */
  log(): string;
  /** SIGTERM our own child, wait for it, escalate on its own handle after 10 s. */
  stop(): Promise<void>;
}

export interface TestApi {
  setKv(key: string, value: string): Promise<void>;
  getKv(key: string): Promise<string | undefined>;
  setSchemaVersion(version: number): Promise<void>;
  getSchemaVersion(): Promise<number>;
  /** Move the server clock forward (real time keeps flowing). */
  advanceClock(ms: number): Promise<void>;
  freezeClock(): Promise<void>;
  unfreezeClock(): Promise<void>;
}
export type TestApiFactory = (server: ServerHandle) => TestApi;

export interface Fixtures {
  dataDir: string;
  kekFile: string;
  convoz: ConvozRun;
  server: (opts?: ServerOptions) => Promise<ServerHandle>;
  /** Run `convoz serve ...` with the same flags as `server`, for a start that must exit by itself. */
  serveCli: (opts?: ServerOptions) => Promise<RunResult>;
  testApi: TestApiFactory;
  /** The ceremony-per-tap guard of this test's browser context (ceremony-guard.ts). */
  guard: CeremonyGuard;
}

let s1aFlags: boolean | undefined;
/** True when the binary under test knows the S1a serve flags (`--host` ...). Cached per worker. */
export function supportsS1aFlags(): boolean {
  if (s1aFlags === undefined) {
    const r = spawnSync(convozBin, ["serve", "-h"], { encoding: "utf8", timeout: 5_000, env: baseEnv(), shell: false });
    s1aFlags = /-host\b/.test(`${r.stdout ?? ""}${r.stderr ?? ""}`);
  }
  return s1aFlags;
}

/** Flags every serve call that is not about the wall carries once the binary requires them. */
export function serveDefaults(): string[] {
  return supportsS1aFlags() ? ["--host", "localhost", "--tailscale", "off"] : [];
}

interface BuiltArgs {
  args: string[];
  readyFile: string;
  sockDir: string;
  host: string;
  adminPath?: string;
}

function buildServeArgs(opts: ServerOptions, dataDir: string, kekFile: string): BuiltArgs {
  const readyDir = fs.mkdtempSync(path.join(os.tmpdir(), "convoz-ready-"));
  const readyFile = path.join(readyDir, "ready.json");
  const sockDir = fs.mkdtempSync(path.join(os.tmpdir(), "convoz-sock-")); // mode 0700; short, a unix path caps at 107 bytes
  const kek = opts.kek === undefined ? kekFile : opts.kek;
  const modern = supportsS1aFlags();
  const host = opts.host ?? "localhost";
  const listen = opts.listenAddr ?? (opts.listen === "unix" ? `unix://${path.join(sockDir, "http.sock")}` : "127.0.0.1:0");
  const adminPath = opts.adminSocket === true ? path.join(sockDir, "admin.sock") : typeof opts.adminSocket === "string" ? opts.adminSocket : undefined;
  const ts = opts.tailscale;
  const args = [
    "serve",
    "--data-dir", opts.dataDir ?? dataDir,
    ...(kek ? ["--kek-file", kek] : []),
    "--listen", listen,
    "--ready-file", readyFile,
    // The S1a flags are always sent when asked for, so a binary without them fails the test (red).
    // Plain defaults are sent only once the binary knows them, so S0 scenarios stay green on an S0 build.
    ...(opts.noHost ? [] : opts.host !== undefined || modern ? ["--host", host] : []),
    ...(adminPath ? ["--admin-socket", adminPath] : []),
    ...(ts?.bin ? ["--tailscale-bin", ts.bin] : []),
    ...(ts?.mode ? ["--tailscale", ts.mode] : !ts?.bin && (modern || ts !== undefined) ? ["--tailscale", "off"] : []),
    ...(opts.extraArgs ?? []),
  ];
  return { args, readyFile, sockDir, host, adminPath };
}

/** A fake KEK: base64 of 32 bytes that start with TESTONLY. Mode 0600. */
function writeKek(dir: string): string {
  const raw = Buffer.alloc(32, 0x2e);
  raw.write("TESTONLY", 0, "ascii");
  const file = path.join(dir, "kek.TESTONLY");
  fs.writeFileSync(file, raw.toString("base64"), { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return file;
}

function waitForReady(readyFile: string, child: ChildProcess, log: () => string, ms: number): Promise<{ listen: string; admin?: string; pid: number }> {
  const dir = path.dirname(readyFile);
  return new Promise((resolve, reject) => {
    const tryRead = (): boolean => {
      try {
        const doc = JSON.parse(fs.readFileSync(readyFile, "utf8"));
        if (typeof doc.listen === "string") {
          done();
          resolve(doc);
          return true;
        }
      } catch {
        /* not written yet, or half-written: wait for the next event */
      }
      return false;
    };
    const watcher = fs.watch(dir, tryRead);
    const timer = setTimeout(() => fail(`server not ready after ${ms} ms`), ms);
    const onExit = (code: number | null, signal: string | null) =>
      fail(`server exited before ready (code ${code}, signal ${signal})`);
    child.once("exit", onExit);
    const done = () => {
      watcher.close();
      clearTimeout(timer);
      child.off("exit", onExit);
    };
    const fail = (msg: string) => {
      done();
      reject(new Error(`${msg}\n--- server log ---\n${log()}`));
    };
    child.once("error", (e) => fail(`cannot start ${convozBin}: ${e.message}`));
    tryRead(); // the file may already exist before the watcher fired
  });
}

export const test = base.extend<Fixtures & { transcript: void }>({
  // Every browser context carries the ceremony guard. In the "mobile" project a tap that breaks the one-ceremony rule
  // fails the test at teardown, whichever scenario it was; in "chromium" only scenarios that assert on guard.violations() fail.
  context: async ({ context }: { context: BrowserContext }, use, testInfo: TestInfo) => {
    // A browser that has not decided on notifications shows the "Turn on notifications" banner; scenarios about it reset the permission.
    await context.grantPermissions(["notifications"]);
    const guard = await installCeremonyGuard(context);
    await use(context);
    const seen = guard.violations();
    if (seen.length) await testInfo.attach("ceremony-violations", { body: seen.join("\n"), contentType: "text/plain" });
    if (testInfo.project.name === "mobile" && seen.length) throw new Error(`ceremony guard: ${[...new Set(seen)].join("; ")}`);
  },

  guard: async ({ context }, use) => {
    await use(await installCeremonyGuard(context));
  },

  // Auto fixture. endTranscript waits for tracked records, so attaching is safe whatever the teardown order.
  // eslint-disable-next-line no-empty-pattern
  transcript: [async ({}, use, testInfo: TestInfo) => {
    beginTranscript();
    await use();
    await testInfo.attach("transcript", { body: await endTranscript(), contentType: "text/plain" });
  }, { auto: true }],

  // eslint-disable-next-line no-empty-pattern
  dataDir: async ({}, use) => {
    // Scratch comes from mkdtemp under the OS temp dir; the OS reaps it.
    await use(fs.mkdtempSync(path.join(os.tmpdir(), "convoz-e2e-")));
  },

  kekFile: async ({}, use) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "convoz-kek-"));
    await use(writeKek(dir));
  },

  // eslint-disable-next-line no-empty-pattern
  convoz: async ({}, use) => {
    await use((argv, opts = {}) =>
      run(convozBin, argv, {
        env: baseEnv(opts.env ?? {}),
        timeoutMs: opts.timeoutMs ?? 20_000,
      }),
    );
  },

  server: async ({ dataDir, kekFile }, use, testInfo: TestInfo) => {
    const started: { handle: ServerHandle; child: ChildProcess; exited: Promise<void>; isDown: () => boolean }[] = [];
    const start = async (opts: ServerOptions = {}): Promise<ServerHandle> => {
      const built = buildServeArgs(opts, dataDir, kekFile);
      const { args, readyFile } = built;
      const child = spawn(convozBin, args, {
        env: baseEnv({ CONVOZ_TEST_ADMIN: "1", ...(opts.env ?? {}) }),
        stdio: ["ignore", "pipe", "pipe"],
        shell: false,
      });
      let buf = "";
      child.stdout.setEncoding("utf8").on("data", (d: string) => (buf += d));
      child.stderr.setEncoding("utf8").on("data", (d: string) => (buf += d));
      let down = false;
      const exited = new Promise<void>((res) => child.once("close", () => { down = true; res(); }));
      const log = () => buf;
      const ready = await waitForReady(readyFile, child, log, 15_000);
      let code: number | null = null;
      child.once("close", (c) => (code = c));
      const stop = async () => {
        if (down) return;
        child.kill("SIGTERM");
        const t = setTimeout(() => child.kill("SIGKILL"), 10_000); // own handle only
        await exited;
        clearTimeout(t);
      };
      // Recorded when the child exits, whoever stopped it.
      track(exited.then(() => record([convozBin, ...args].join(" "), buf, "", `exit=${code}`)));
      const tcp = ready.listen.startsWith("tcp://");
      const tcpPort = tcp ? Number(ready.listen.replace(/^tcp:\/\/.*:/, "")) : undefined;
      const unixPath = ready.listen.startsWith("unix://") ? ready.listen.replace(/^unix:\/\//, "") : undefined;
      const origin = built.host === "localhost" && tcp ? `http://localhost:${tcpPort}` : built.host === "localhost" ? "http://localhost" : `https://${built.host}`;
      const target: Target = { host: built.host, origin, ...(tcp ? { tcpPort } : { unixPath }) };
      const handle: ServerHandle = {
        url: tcp ? "http://" + ready.listen.replace(/^tcp:\/\//, "") : "http://localhost",
        host: built.host,
        origin,
        ...(tcpPort !== undefined ? { tcpPort } : {}),
        ...(unixPath !== undefined ? { unixPath } : {}),
        ...(ready.admin ? { adminSocket: ready.admin.replace(/^unix:\/\//, "") } : {}),
        target,
        ready,
        pid: child.pid ?? ready.pid,
        log,
        stop,
      };
      started.push({ handle, child, exited, isDown: () => down });
      return handle;
    };
    await use(start);
    for (const s of started.reverse()) await s.handle.stop();
    if (testInfo.status !== testInfo.expectedStatus) {
      for (const [i, s] of started.entries()) {
        await testInfo.attach(`server-${i}.log`, { body: s.handle.log(), contentType: "text/plain" });
      }
    }
  },

  serveCli: async ({ dataDir, kekFile }, use) => {
    await use((opts = {}) => {
      const { args } = buildServeArgs(opts, dataDir, kekFile);
      return run(convozBin, args, {
        env: baseEnv({ CONVOZ_TEST_ADMIN: "1", ...(opts.env ?? {}) }),
        timeoutMs: opts.timeoutMs ?? 8_000,
      });
    });
  },

  // eslint-disable-next-line no-empty-pattern
  testApi: async ({}, use) => {
    await use((srv) => {
      // Through the HTTP helper so Host is right for the wall (127.0.0.1:<port> would be a 421).
      const call = async (method: string, route: string, body?: unknown): Promise<{ ok: boolean; status: number; text: string; json: () => any }> => {
        const res = await send(srv.target, method, route, body === undefined ? {} : { json: body });
        return { ok: res.status >= 200 && res.status < 300, status: res.status, text: res.text, json: () => res.json() };
      };
      const must = async (res: { ok: boolean; status: number; text: string }, what: string) => {
        if (!res.ok) throw new Error(`${what}: HTTP ${res.status} ${res.text}`);
      };
      return {
        setKv: async (key, value) => must(await call("POST", "/__test/kv", { key, value }), "POST /__test/kv"),
        getKv: async (key) => {
          const res = await call("GET", `/__test/kv?key=${encodeURIComponent(key)}`);
          if (res.status === 404) return undefined;
          await must(res, "GET /__test/kv");
          return res.json().value as string;
        },
        setSchemaVersion: async (version) =>
          must(await call("POST", "/__test/schema-version", { version }), "POST /__test/schema-version"),
        getSchemaVersion: async () => {
          const res = await call("GET", "/__test/schema-version");
          await must(res, "GET /__test/schema-version");
          return res.json().version as number;
        },
        advanceClock: async (ms) => must(await call("POST", "/__test/clock", { advance_ms: ms }), "POST /__test/clock advance"),
        freezeClock: async () => must(await call("POST", "/__test/clock", { freeze: true }), "POST /__test/clock freeze"),
        unfreezeClock: async () => must(await call("POST", "/__test/clock", { unfreeze: true }), "POST /__test/clock unfreeze"),
      };
    });
  },
});

export { expect } from "@playwright/test";
