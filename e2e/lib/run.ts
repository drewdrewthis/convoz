import { spawn } from "node:child_process";
import path from "node:path";

/** Absolute path of the repo root (e2e/lib -> repo). */
export const repoRoot = path.resolve(import.meta.dirname, "..", "..");

export interface RunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface RunOptions {
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
}

/**
 * Environment every child gets: the minimum to run, nothing from the host that could
 * point a child at a real credential. Callers add what they need.
 */
export function baseEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of ["PATH", "HOME", "LANG", "TMPDIR"]) {
    const v = process.env[k];
    if (v !== undefined) env[k] = v;
  }
  return { ...env, ...extra };
}

/**
 * Run `file` with `args` by argv (never through a shell) and collect its output.
 * The child is bounded by its own handle: on timeout this kills that child only.
 * A binary that does not exist rejects with a message naming the path.
 */
export function run(file: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  const timeoutMs = opts.timeoutMs ?? 20_000;
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      cwd: opts.cwd ?? repoRoot,
      env: opts.env ?? baseEnv(),
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.setEncoding("utf8").on("data", (d: string) => (stdout += d));
    child.stderr.setEncoding("utf8").on("data", (d: string) => (stderr += d));
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL"); // our own handle
    }, timeoutMs);
    child.once("error", (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      reject(new Error(`cannot run ${file}: ${err.code ?? ""} ${err.message}`));
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr, timedOut });
    });
  });
}

/** pnpm, run the way the parent pnpm was started (npm_execpath) so no PATH lookup is needed. */
export function pnpmCommand(): { file: string; prefix: string[] } {
  const exec = process.env.npm_execpath;
  if (exec && /\.(c|m)?js$/.test(exec)) return { file: process.execPath, prefix: [exec] };
  return { file: "pnpm", prefix: [] };
}

/** The Go tool: GO_BIN, else /usr/local/go/bin/go. */
export const goBin = process.env.GO_BIN ?? "/usr/local/go/bin/go";
