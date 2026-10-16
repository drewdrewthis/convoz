import os from "node:os";
import { repoRoot } from "./paths.ts";

const EDGE_LINES = 40;

interface Entry {
  cmd: string;
  body: string;
  trailer: string;
}

/** Entries of the test running in this worker (a worker runs one test at a time). */
let active: Entry[] | null = null;

/** Records still on their way (a child that has not exited yet); see `track`. */
let pending: Promise<unknown>[] = [];

/** Start recording for one test. */
export function beginTranscript(): void {
  active = [];
  pending = [];
}

/**
 * Register a promise that will call `record` when it settles (e.g. a server's exit).
 * Rule: any record that lands after the code that started the process returns must go
 * through `track`, so `endTranscript` waits for it and teardown order cannot lose it.
 */
export function track(p: Promise<unknown>): void {
  pending.push(p);
}

/** Wait for tracked records, stop recording and return the rendered `transcript` text. */
export async function endTranscript(): Promise<string> {
  await Promise.allSettled(pending);
  pending = [];
  const entries = active ?? [];
  active = null;
  return entries.map((e) => [`$ ${e.cmd}`, e.body, e.trailer].filter((s) => s !== "").join("\n")).join("\n\n") + "\n";
}

/** Record one finished process or HTTP call; a no-op outside a test. */
export function record(cmd: string, stdout: string, stderr: string, trailer: string): void {
  if (!active) return;
  const out = [trim(show(stdout)), trim(show(stderr)).replace(/^(?=.)/gm, "stderr: ")].filter((s) => s !== "").join("\n");
  active.push({ cmd: show(cmd), body: out, trailer });
}

/** Temp paths read as $TMP and the repo root as `.`, so transcripts do not depend on the host. */
function show(text: string): string {
  const tmp = os.tmpdir().replace(/\/+$/, "");
  return text.split(repoRoot).join(".").split(tmp).join("$TMP");
}

/** Keep the first and last lines; p95 lines survive the cut because they are the bench proof. */
function trim(text: string): string {
  const lines = text.replace(/\n+$/, "").split("\n");
  if (lines.length <= EDGE_LINES * 2) return lines.join("\n");
  const middle = lines.slice(EDGE_LINES, -EDGE_LINES);
  const kept = middle.filter((l) => /p95/.test(l));
  const note = `... ${middle.length - kept.length} lines trimmed ...`;
  return [...lines.slice(0, EDGE_LINES), note, ...kept, ...lines.slice(-EDGE_LINES)].join("\n");
}
