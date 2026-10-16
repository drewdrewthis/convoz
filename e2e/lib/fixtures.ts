import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test as base, type TestInfo } from "@playwright/test";
import { baseEnv, repoRoot, run, type RunResult } from "./run.ts";
import { beginTranscript, endTranscript, record } from "./transcript.ts";

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

export interface ServerOptions {
  /** Data dir to serve; default: the dataDir fixture. */
  dataDir?: string;
  /** KEK file to pass; `null` passes none. Default: the kekFile fixture. */
  kek?: string | null;
  /** Extra env (after CONVOZ_TEST_ADMIN=1). */
  env?: Record<string, string>;
  extraArgs?: string[];
}

export interface ServerHandle {
  /** `http://127.0.0.1:<port>` */
  url: string;
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
}
export type TestApiFactory = (server: ServerHandle) => TestApi;

export interface Fixtures {
  dataDir: string;
  kekFile: string;
  convoz: ConvozRun;
  server: (opts?: ServerOptions) => Promise<ServerHandle>;
  testApi: TestApiFactory;
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

function waitForReady(readyFile: string, child: ChildProcess, log: () => string, ms: number): Promise<{ listen: string; pid: number }> {
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
  // Auto fixture; server depends on it so its teardown (server stop, which records) runs first.
  // eslint-disable-next-line no-empty-pattern
  transcript: [async ({}, use, testInfo: TestInfo) => {
    beginTranscript();
    await use();
    await testInfo.attach("cli-transcript", { body: endTranscript(), contentType: "text/plain" });
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

  server: async ({ dataDir, kekFile, transcript }, use, testInfo: TestInfo) => {
    const started: { handle: ServerHandle; child: ChildProcess; exited: Promise<void>; isDown: () => boolean }[] = [];
    const start = async (opts: ServerOptions = {}): Promise<ServerHandle> => {
      const readyDir = fs.mkdtempSync(path.join(os.tmpdir(), "convoz-ready-"));
      const readyFile = path.join(readyDir, "ready.json");
      const kek = opts.kek === undefined ? kekFile : opts.kek;
      const args = [
        "serve",
        "--data-dir", opts.dataDir ?? dataDir,
        ...(kek ? ["--kek-file", kek] : []),
        "--listen", "127.0.0.1:0",
        "--ready-file", readyFile,
        ...(opts.extraArgs ?? []),
      ];
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
      void exited.then(() => record([convozBin, ...args].join(" "), buf, "", `exit=${code}`));
      const handle: ServerHandle = {
        url: "http://" + ready.listen.replace(/^tcp:\/\//, ""),
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

  // eslint-disable-next-line no-empty-pattern
  testApi: async ({}, use) => {
    await use((srv) => {
      const call = async (method: string, route: string, body?: unknown): Promise<Response> => {
        const res = await fetch(srv.url + route, {
          method,
          headers: body === undefined ? {} : { "content-type": "application/json" },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(10_000),
        });
        record(`HTTP ${method} ${route}${body === undefined ? "" : " " + JSON.stringify(body)}`, await res.clone().text(), "", `status=${res.status}`);
        return res;
      };
      const must = async (res: Response, what: string) => {
        if (!res.ok) throw new Error(`${what}: HTTP ${res.status} ${await res.text()}`);
      };
      return {
        setKv: async (key, value) => must(await call("POST", "/__test/kv", { key, value }), "POST /__test/kv"),
        getKv: async (key) => {
          const res = await call("GET", `/__test/kv?key=${encodeURIComponent(key)}`);
          if (res.status === 404) return undefined;
          await must(res, "GET /__test/kv");
          return (await res.json()).value as string;
        },
        setSchemaVersion: async (version) =>
          must(await call("POST", "/__test/schema-version", { version }), "POST /__test/schema-version"),
        getSchemaVersion: async () => {
          const res = await call("GET", "/__test/schema-version");
          await must(res, "GET /__test/schema-version");
          return (await res.json()).version as number;
        },
      };
    });
  },
});

export { expect } from "@playwright/test";
