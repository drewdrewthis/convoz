#!/usr/bin/env node
// A fake `tailscale` CLI for tests. Never run through a shell; the server execs it by argv.
//
// It reads `config.json` that sits NEXT to this file (tests copy the script into a scratch
// dir per test, see fake-tailscale.ts), so it needs no environment variable.
//
// config.json:
//   {
//     "serve":       { ... }   // printed for `serve status --json` and `funnel status --json`
//                              // (a Tailscale ServeConfig: TCP, Web, AllowFunnel, Foreground, Services)
//     "serveExit":   0         // exit code for those commands (default 0)
//     "serveStderr": ""        // written to stderr when serveExit is not 0
//     "whois": { "<ip>": { ... } }   // printed for `whois --json <ip>[:port]` (a WhoIsResponse:
//                                    // {"Node":{"Name":"laptop-1.tailnet.ts.net.","Tags":[...]},"UserProfile":{...}})
//   }
// An ip with no entry in "whois" exits 1 with `can't look up <ip>: peer not found` on stderr.
// Every call appends one JSON line (the argv) to `calls.jsonl` next to this file.
// Any other command exits 2.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
fs.appendFileSync(path.join(here, "calls.jsonl"), JSON.stringify(args) + "\n");
let cfg = {};
try {
  cfg = JSON.parse(fs.readFileSync(path.join(here, "config.json"), "utf8"));
} catch {
  /* no config: every query answers empty */
}

const words = args.filter((a) => !a.startsWith("-"));
const json = args.includes("--json");

if (words[0] === "whois" && json) {
  let ip = words[1] ?? "";
  const bracket = ip.match(/^\[(.*)\](?::\d+)?$/);
  if (bracket) ip = bracket[1];
  else if (/^\d+\.\d+\.\d+\.\d+:\d+$/.test(ip)) ip = ip.replace(/:\d+$/, "");
  const doc = cfg.whois?.[ip];
  if (doc === undefined) {
    process.stderr.write(`can't look up ${ip}: peer not found\n`);
    process.exit(1);
  }
  process.stdout.write(JSON.stringify(doc) + "\n");
} else if ((words[0] === "serve" || words[0] === "funnel") && words[1] === "status" && json) {
  const code = cfg.serveExit ?? 0;
  if (code !== 0) {
    process.stderr.write((cfg.serveStderr ?? "fake tailscale: status unavailable") + "\n");
    process.exit(code);
  }
  process.stdout.write(JSON.stringify(cfg.serve ?? {}) + "\n");
} else {
  process.stderr.write(`fake tailscale: unsupported command: ${args.join(" ")}\n`);
  process.exit(2);
}
