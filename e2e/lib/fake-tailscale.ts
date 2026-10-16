import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** What the fake `tailscale` answers; see fake-tailscale.mjs for the format. */
export interface FakeTailscaleConfig {
  serve?: Record<string, unknown>;
  serveExit?: number;
  serveStderr?: string;
  whois?: Record<string, unknown>;
}

export interface FakeTailscale {
  /** Absolute path to pass as `--tailscale-bin`. */
  bin: string;
  /** Replace the config; takes effect on the next call. */
  set(cfg: FakeTailscaleConfig): void;
  /** Every argv the server passed, in order. */
  calls(): string[][];
}

const script = path.join(import.meta.dirname, "fake-tailscale.mjs");

/**
 * Copy the fake into its own scratch dir (so each test has its own config) with a shebang
 * naming this node binary by absolute path, so the server needs no PATH to exec it.
 */
export function fakeTailscale(cfg: FakeTailscaleConfig = {}): FakeTailscale {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "convoz-ts-"));
  const bin = path.join(dir, "tailscale");
  const body = fs.readFileSync(script, "utf8").replace(/^#!.*\n/, `#!${process.execPath}\n`);
  fs.writeFileSync(bin, body, { mode: 0o755 });
  fs.chmodSync(bin, 0o755);
  const set = (c: FakeTailscaleConfig) => fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify(c));
  set(cfg);
  return {
    bin,
    set,
    calls: () => {
      try {
        return fs
          .readFileSync(path.join(dir, "calls.jsonl"), "utf8")
          .split("\n")
          .filter(Boolean)
          .map((l) => JSON.parse(l) as string[]);
      } catch {
        return [];
      }
    },
  };
}

/**
 * A ServeConfig with funnel on for `hostPort` ("convoz.testonly.ts.net:443") proxying `proxy`
 * ("http://127.0.0.1:41000" or "unix:/abs/http.sock"). `where` picks the top-level maps or a Foreground session.
 */
export function funnelConfig(hostPort: string, proxy: string, opts: { allowFunnel?: boolean; where?: "top" | "foreground" } = {}): Record<string, unknown> {
  const body = {
    TCP: { "443": { HTTPS: true } },
    Web: { [hostPort]: { Handlers: { "/": { Proxy: proxy } } } },
    AllowFunnel: { [hostPort]: opts.allowFunnel ?? true },
  };
  return opts.where === "foreground" ? { Foreground: { "TESTONLY-session": body } } : body;
}
