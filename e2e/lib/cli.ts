import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { convozBin } from "./fixtures.ts";
import { baseEnv, type RunResult } from "./run.ts";
import { record, track } from "./transcript.ts";

export interface CliOptions {
  /** `CONVOZ_AS` for this call. */
  as?: string;
  /** `CLAUDE_CODE_SESSION_ID` for this call: the client id of the lease (S1 plan §3.2). */
  claude?: string;
  /** More environment (after HOME and the two above). */
  env?: Record<string, string>;
  /** Written to the child's stdin, then closed (`login --stdin`). */
  stdin?: string;
  timeoutMs?: number;
}

/** A `convoz` child that is still running. Bounded by its own handle: a timeout kills this child only. */
export interface Running {
  /** Resolves when the child has exited. Never rejects. */
  readonly done: Promise<RunResult>;
  stdout(): string;
  stderr(): string;
  /** SIGTERM this child (its own handle). Safe after exit. */
  stop(): void;
  /** Resolve with the match once stdout shows `re`; reject if the child exits first or `ms` pass. */
  waitForStdout(re: RegExp, ms?: number): Promise<RegExpMatchArray>;
}

function spawnCli(argv: string[], env: Record<string, string>, cwd: string, stdin: string | undefined, timeoutMs: number): Running {
  const child = spawn(convozBin, argv, { env, cwd, stdio: [stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"], shell: false });
  let stdout = "";
  let stderr = "";
  let timedOut = false;
  let exited = false;
  const watchers = new Set<() => void>();
  const wake = () => [...watchers].forEach((w) => w());
  child.stdout?.setEncoding("utf8").on("data", (d: string) => {
    stdout += d;
    wake();
  });
  child.stderr?.setEncoding("utf8").on("data", (d: string) => (stderr += d));
  if (stdin !== undefined) {
    child.stdin?.on("error", () => undefined); // the child may exit before it reads
    child.stdin?.end(stdin);
  }
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL"); // our own handle
  }, timeoutMs);
  const done = new Promise<RunResult>((resolve) => {
    const finish = (code: number | null, signal: NodeJS.Signals | null, note = "") => {
      clearTimeout(timer);
      exited = true;
      record(
        ["convoz", ...argv].join(" "),
        stdout,
        stderr + note,
        `exit=${code}${signal ? ` signal=${signal}` : ""}${timedOut ? " timedOut" : ""}`,
      );
      wake();
      resolve({ code, signal, stdout, stderr: stderr + note, timedOut });
    };
    child.once("error", (e) => finish(null, null, `cannot run ${convozBin}: ${e.message}`));
    child.once("close", (code, signal) => finish(code, signal));
  });
  track(done);
  return {
    done,
    stdout: () => stdout,
    stderr: () => stderr,
    stop: () => {
      if (!exited) child.kill("SIGTERM");
    },
    waitForStdout: (re, ms = 15_000) =>
      new Promise((resolve, reject) => {
        const timeout = setTimeout(() => settle(new Error(`no ${re} on stdout after ${ms} ms\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`)), ms);
        const settle = (err?: Error, m?: RegExpMatchArray) => {
          clearTimeout(timeout);
          watchers.delete(check);
          if (err) reject(err);
          else resolve(m!);
        };
        const check = () => {
          const m = stdout.match(re);
          if (m) settle(undefined, m);
          else if (exited) settle(new Error(`convoz exited before stdout showed ${re}\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`));
        };
        watchers.add(check);
        check();
      }),
  };
}

/**
 * One machine's shell: its own HOME in scratch, so its config dir `~/.config/convoz` is private to it
 * (credentials file 0600 in a 0700 dir, session files under `sessions/`). The environment is the minimum
 * (`baseEnv`): no `DBUS_SESSION_BUS_ADDRESS`, so no OS keychain exists, like headless Linux.
 *
 * Contract: see the comment block at the top of tests/machine-login.spec.ts.
 */
export class CliMachine {
  readonly home = fs.mkdtempSync(path.join(os.tmpdir(), "convoz-m-"));
  /** `~/.config/convoz` of this machine. */
  readonly configDir = path.join(this.home, ".config", "convoz");

  get credentialsPath(): string {
    return path.join(this.configDir, "credentials");
  }

  sessionPath(sid: string): string {
    return path.join(this.configDir, "sessions", sid);
  }

  /** The environment of a call. HOME is this machine's; XDG_CONFIG_HOME is not set, so the default `~/.config` is what is proven. */
  env(o: CliOptions = {}): Record<string, string> {
    return baseEnv({
      HOME: this.home,
      ...(o.as ? { CONVOZ_AS: o.as } : {}),
      ...(o.claude ? { CLAUDE_CODE_SESSION_ID: o.claude } : {}),
      ...(o.env ?? {}),
    });
  }

  /** Start any `convoz` command and keep it running. */
  start(argv: string[], o: CliOptions = {}): Running {
    return spawnCli(argv, this.env(o), this.home, o.stdin, o.timeoutMs ?? 25_000);
  }

  /** Run a `convoz` command to its end. */
  run(argv: string[], o: CliOptions = {}): Promise<RunResult> {
    return this.start(argv, o).done;
  }

  /** `convoz login --server S --name N ...` left running (it waits for the owner). */
  startLogin(server: string, name: string, extra: string[] = [], o: CliOptions = {}): Running {
    return this.start(["login", "--server", server, "--name", name, ...extra], o);
  }

  /** Put a known machine key on this machine, the way a revealed key is: `convoz login --stdin` with the key on stdin. */
  install(server: string, name: string, key: string): Promise<RunResult> {
    return this.run(["login", "--stdin", "--server", server, "--name", name, "--store", "file"], { stdin: `${key}\n` });
  }

  whoami(args: string[] = [], o: CliOptions = {}): Promise<RunResult> {
    return this.run(["whoami", ...args], o);
  }

  sessionStart(as: string, extra: string[] = [], o: CliOptions = {}): Promise<RunResult> {
    return this.run(["session", "start", "--as", as, ...extra], o);
  }

  sessionEnd(sid: string, o: CliOptions = {}): Promise<RunResult> {
    return this.run(["session", "end", "--sid", sid], o);
  }

  /** The lease a session file holds. The file is JSON: `{"lease":"cvz_s_...","identity":"...","machine":"...","client_id":"..."}`. */
  leaseOf(sid: string): string {
    return JSON.parse(fs.readFileSync(this.sessionPath(sid), "utf8")).lease as string;
  }
}

/** The local session id `convoz session start` printed: one line `CONVOZ_SID=<hex>`. */
export function sidOf(res: RunResult): string {
  const m = res.stdout.match(/^CONVOZ_SID=([0-9a-f]{6,})$/m);
  if (!m) throw new Error(`no CONVOZ_SID in stdout (exit ${res.code})\n--- stdout ---\n${res.stdout}\n--- stderr ---\n${res.stderr}`);
  return m[1]!;
}

/** The permission bits of a path. */
export const modeOf = (p: string): number => fs.statSync(p).mode & 0o777;

/** A machine that holds `key` as its machine key (a revealed key installed with `login --stdin`). */
export async function installedMachine(server: string, name: string, key: string): Promise<CliMachine> {
  const m = new CliMachine();
  const res = await m.install(server, name, key);
  if (res.code !== 0) throw new Error(`install the key of ${name}: exit ${res.code}\n${res.stderr}`);
  return m;
}
