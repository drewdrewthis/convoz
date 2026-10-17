import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { conversationsWithMentions } from "./inbox.ts";
import { createConversation, ownerSays, startSession } from "./chat.ts";
import { installedMachine, type CliMachine } from "./cli.ts";
import { convozBin } from "./fixtures.ts";
import type { ServerHandle, ServerOptions } from "./fixtures.ts";
import type { Target } from "./http.ts";
import { idsByHandle, msgWorld, type MsgWorld } from "./messages-wp4.ts";
import { record, track } from "./transcript.ts";

/**
 * Helpers of the agent-surface scenarios of WP7 (brief-handoff.feature, cli-mcp.feature, sessions.feature):
 * the brief fixture, the MCP stdio client, the stub `claude`, and the proxies that lose, refuse or hold a response.
 *
 * ROUTES the bindings rely on (all with a lease unless noted):
 *   GET   /api/brief?max_bytes=&page=   -> {text, sections:[{key,title,text}], bytes, page}   (no side effects)
 *   POST  /api/handoffs {client_id, body} -> 201/200 {id, body, created_at, session, machine}; body 1..4096 bytes, else 400
 *   GET   /api/handoffs[?identity=]       -> {handoffs:[...]} newest first (owner: ?identity=<handle>)
 *   PATCH /api/me/profile {display_name?, description?, capabilities?}  -> 200 profile; again within an hour -> 429
 * CLI: `convoz brief [--max-bytes N] [--page N]`, `convoz handoff <note|-> | --list`, `convoz profile --set k=v ...`,
 *      `convoz setup --as H [--scope S]`, `convoz mcp --as H`; every one takes --json.
 * The brief is text with titled sections: "## Who you are", "## Last handoff", "## Answers waiting", "## Open asks", "## Inbox",
 * "## Conversations with unread messages", "## Recent decisions", "## Expired unread".
 */

type Fx = { server: (o?: ServerOptions) => Promise<ServerHandle>; dataDir: string };

const DAY = 86_400_000;

// ---- the brief fixture -------------------------------------------------------------------------------------------------

export interface BriefWorld extends MsgWorld {
  /** Conversation ids with unread messages for devtool: 41 and two more. */
  unread: number[];
  /** "Secret merger plan": the owner and "docs", not devtool. */
  secret: number;
  ids: Record<string, number>;
  /** Questions of the fixture's asks, so a scenario can look for them in the brief. */
  asks: { open: string; unacked: string; decision: string };
}

export const NOTE_FIRST = "Halfway through #412; tests 3 and 7 still flaky";

/** Insert an ask by `asker` in `conv` the way the ask module will: options first, then sealed, then answered. Returns the message id. */
export function seedAsk(
  db: DatabaseSync,
  o: { conv: number; asker: number; owner: number; question: string; answered?: { label: string; at: number; acked: boolean } },
): number {
  const now = Date.now();
  const m = db.prepare("INSERT INTO messages (conversation_id, author_id, kind, body, created_at) VALUES (?, ?, 'ask', ?, ?)").run(o.conv, o.asker, o.question, now);
  const id = Number(m.lastInsertRowid);
  db.prepare("INSERT INTO asks (message_id, conversation_id, asker_id, question, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").run(id, o.conv, o.asker, o.question, now, now);
  const option = db.prepare("INSERT INTO ask_options (message_id, idx, label, why) VALUES (?, ?, ?, ?)");
  option.run(id, 0, o.answered?.label ?? "Use the small runner", "It is the cheapest");
  option.run(id, 1, "Use the big runner", "It is faster");
  db.prepare("UPDATE asks SET sealed = 1 WHERE message_id = ?").run(id);
  if (o.answered) {
    db.prepare(
      "UPDATE asks SET state = 'answered', chosen_kind = 'recommended', answer_via = 'inline', resolved_by = ?, resolved_at = ?, acked_at = ?, updated_at = ?, version = version + 1 WHERE message_id = ?",
    ).run(o.owner, o.answered.at, o.answered.acked ? o.answered.at + 1000 : null, o.answered.at, id);
  } else {
    db.prepare("UPDATE conversations SET open_ask_count = open_ask_count + 1 WHERE id = ?").run(o.conv);
  }
  return id;
}

/**
 * Background: a fresh server with owner "drew", machine "box-2" logged in with allow-list "devtool", and the brief fixture: "devtool" has
 * unread inbox items (a mention and two activity items), an unacked answer, an open ask, 3 conversations with unread messages, a decision
 * from 2 days ago and 2 handoff notes, and a conversation "Secret merger plan" that "devtool" is not in.
 */
export async function briefWorld(fx: Fx): Promise<BriefWorld> {
  const w = await msgWorld({ ...fx, agents: ["devtool", "docs"], participants: ["devtool"] });
  const deploy = await createConversation(w.owner, { participants: ["devtool"], title: "Deploy alerts runbook" });
  const release = await createConversation(w.owner, { participants: ["devtool"], title: "Release 1.4 notes" });
  const secret = await createConversation(w.owner, { participants: ["docs"], title: "Secret merger plan" });
  await ownerSays(w.owner, secret, "the merger closes on Friday");
  await ownerSays(w.owner, w.conv, "Is the build green?");
  await ownerSays(w.owner, deploy, "@devtool the alert fired twice");
  await ownerSays(w.owner, release, "Draft the notes please");

  const db = w.db();
  const ids = idsByHandle(db);
  const asks = { open: "Which runner should the CI use?", unacked: "Ship the filters behind a flag?", decision: "Which database holds the index?" };
  seedAsk(db, { conv: w.conv, asker: ids.devtool!, owner: ids.drew!, question: asks.open });
  seedAsk(db, { conv: w.conv, asker: ids.devtool!, owner: ids.drew!, question: asks.unacked, answered: { label: "Yes, behind a flag", at: Date.now() - 3_600_000, acked: false } });
  seedAsk(db, { conv: w.conv, asker: ids.devtool!, owner: ids.drew!, question: asks.decision, answered: { label: "SQLite FTS5", at: Date.now() - 2 * DAY, acked: true } });
  db.close();

  const world: BriefWorld = { ...w, unread: [w.conv, deploy, release], secret, ids, asks };
  const s1 = await startSession(w.box, "devtool", "earlier-1");
  const s2 = await startSession(w.box, "devtool", "earlier-2");
  for (const [sid, note] of [[s1.sid, "First note: the flag name is search_chips"], [s2.sid, NOTE_FIRST]] as const) {
    const res = await w.box.run(["handoff", "--sid", sid, "--timeout", "10s", note], { timeoutMs: 20_000 });
    if (res.code !== 0) throw new Error(`handoff: exit ${res.code}\n${res.stderr}`);
  }
  return world;
}

/** Make "devtool" have `n` conversations with unread messages in all (the fixture has 3). */
export async function unreadConversations(w: BriefWorld, n: number): Promise<number[]> {
  const more = await conversationsWithMentions(w.owner, n - w.unread.length, "devtool");
  return [...w.unread, ...more];
}

/** A fresh session of "devtool" running a command the way the scenarios say: `convoz <cmd> --as devtool` in a Claude session of its own. */
export function asDevtool(w: MsgWorld, label: string, argv: string[], o: { stdin?: string; timeoutMs?: number } = {}) {
  return w.box.run([...argv, "--as", "devtool", "--timeout", "10s"], { claude: `claude-TESTONLY-${label}`, timeoutMs: o.timeoutMs ?? 20_000, ...(o.stdin !== undefined ? { stdin: o.stdin } : {}) });
}

/** The section of a brief with this title (without its title line), or "" when there is none. */
export function sectionOf(brief: string, title: string): string {
  const start = brief.indexOf(`## ${title}`);
  if (start < 0) return "";
  const rest = brief.slice(start);
  const end = rest.indexOf("\n## ", 3);
  return (end < 0 ? rest : rest.slice(0, end)).split("\n").slice(1).join("\n");
}

export const CONVERSATIONS = "Conversations with unread messages";

/** The conversation ids a brief lists, in order, and the last line of that section. */
export function listedConversations(brief: string): { ids: number[]; last: string } {
  const lines = sectionOf(brief, CONVERSATIONS).split("\n").filter((l) => l !== "");
  return { ids: lines.filter((l) => l.startsWith("- ")).map((l) => Number(/^- (\d+) /.exec(l)?.[1])), last: lines.at(-1) ?? "" };
}

/** How often `needle` occurs in `hay`. */
export const occurrences = (hay: string, needle: string): number => hay.split(needle).length - 1;

// ---- the MCP server over stdio ------------------------------------------------------------------------------------------

interface Pending {
  resolve(v: any): void;
  reject(e: Error): void;
}

/** A client of `convoz mcp`: newline-delimited JSON-RPC over the child's standard input and output. Close it with `end()` or `kill()`. */
export class McpClient {
  private buffer = "";
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  readonly stderr: string[] = [];
  /** Resolves with the exit code when the server process ends. */
  readonly exited: Promise<number | null>;
  private readonly child: ChildProcess;
  private ended = false;

  constructor(box: CliMachine, argv: string[], claude: string) {
    this.child = spawn(convozBin, argv, { env: box.env({ claude }), cwd: box.home, stdio: ["pipe", "pipe", "pipe"], shell: false });
    this.child.stdout!.setEncoding("utf8").on("data", (d: string) => this.onData(d));
    this.child.stderr!.setEncoding("utf8").on("data", (d: string) => this.stderr.push(d));
    this.child.stdin!.on("error", () => undefined);
    this.exited = new Promise((resolve) => {
      this.child.once("close", (code) => {
        this.ended = true;
        for (const p of this.pending.values()) p.reject(new Error(`convoz mcp exited (${code}) before it answered\n${this.stderr.join("")}`));
        record(["convoz", ...argv].join(" "), "(MCP session over stdio)", this.stderr.join(""), `exit=${code}`);
        resolve(code);
      });
      this.child.once("error", () => resolve(null));
    });
    track(this.exited);
  }

  /** Start `convoz mcp --as H` for a Claude session (its client id is `claude`) and finish the handshake. */
  static async start(box: CliMachine, as: string, claude: string): Promise<McpClient> {
    const c = new McpClient(box, ["mcp", "--as", as], claude);
    await c.call("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "convoz-e2e", version: "0.0.0" } });
    c.write({ jsonrpc: "2.0", method: "notifications/initialized" });
    return c;
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    for (let i = this.buffer.indexOf("\n"); i >= 0; i = this.buffer.indexOf("\n")) {
      const line = this.buffer.slice(0, i).trim();
      this.buffer = this.buffer.slice(i + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      const p = this.pending.get(msg.id);
      if (!p) continue; // a notification or a request of the server
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(`MCP error ${msg.error.code}: ${msg.error.message}`));
      else p.resolve(msg.result);
    }
  }

  private write(msg: unknown): void {
    this.child.stdin!.write(JSON.stringify(msg) + "\n");
  }

  call(method: string, params: unknown, ms = 20_000): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`no answer to ${method} in ${ms} ms\n${this.stderr.join("")}`));
      }, ms);
      this.pending.set(id, { resolve: (v) => (clearTimeout(timer), resolve(v)), reject: (e) => (clearTimeout(timer), reject(e)) });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  listTools(): Promise<{ name: string; description: string; inputSchema: any }[]> {
    return this.call("tools/list", {}).then((r) => r.tools);
  }

  /** `tools/call`: returns the whole result (`content`, `structuredContent`, `isError`). */
  tool(name: string, args: Record<string, unknown> = {}): Promise<{ content: { type: string; text: string }[]; structuredContent?: any; isError?: boolean }> {
    return this.call("tools/call", { name, arguments: args }, 30_000);
  }

  /** Close the server's input: a clean end, which ends the lease. */
  end(): void {
    if (!this.ended) this.child.stdin!.end();
  }

  /** SIGTERM: the process is gone at once and leaves its lease, as a Claude Code that restarts it would. */
  kill(): void {
    if (!this.ended) this.child.kill("SIGTERM");
  }
}

// ---- a stub `claude` ------------------------------------------------------------------------------------------------------

/** A directory with an executable `claude` that records its arguments as JSON in `out`. Returns the directory (for PATH) and a reader. */
export function stubClaude(): { dir: string; recorded(): string[] | null } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "convoz-claude-"));
  const out = path.join(dir, "argv.json");
  fs.writeFileSync(path.join(dir, "claude"), `#!${process.execPath}\nrequire("node:fs").writeFileSync(${JSON.stringify(out)}, JSON.stringify(process.argv.slice(2)));\n`, { mode: 0o755 });
  return { dir, recorded: () => (fs.existsSync(out) ? (JSON.parse(fs.readFileSync(out, "utf8")) as string[]) : null) };
}

/** A directory with nothing in it, as the PATH of a machine without Claude Code. */
export const emptyDir = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "convoz-empty-"));

/** Every file under `root` except `skip`, with its size and mode: what "nothing outside ~/.config/convoz changed" compares. */
export function treeOf(root: string, skip: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (p === skip) continue;
      const st = fs.lstatSync(p);
      out.push(`${path.relative(root, p)} ${e.isDirectory() ? "dir" : st.size} ${st.mode.toString(8)}`);
      if (e.isDirectory()) walk(p);
    }
  };
  walk(root);
  return out.sort();
}

// ---- proxies that refuse or hold ------------------------------------------------------------------------------------------

export interface Counted {
  /** `http://127.0.0.1:<port>`: the server address of a machine. */
  url: string;
  /** Requests that matched the rule, in order. */
  hits: { method: string; path: string }[];
  close(): Promise<void>;
}

/** A forwarder that answers `status` (no Retry-After) to every request for `method path` and passes all others to the server. */
export async function refusingProxy(target: Target, rule: { method: string; path: string; status: number }): Promise<Counted> {
  if (target.tcpPort === undefined) throw new Error("refusingProxy: the target must be a TCP listener");
  const hits: Counted["hits"] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const route = (req.url ?? "").split("?")[0] ?? "";
      if (req.method === rule.method && route === rule.path) {
        hits.push({ method: rule.method, path: route });
        res.writeHead(rule.status, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { code: "rate_limited", message: "Too many tries." } }));
        return;
      }
      const up = http.request(
        { host: "127.0.0.1", port: target.tcpPort, method: req.method, path: req.url, agent: false, headers: { ...req.headers, host: `${target.host}:${target.tcpPort}`, connection: "close" } },
        (ur) => {
          res.writeHead(ur.statusCode ?? 502, ur.headers);
          ur.pipe(res);
        },
      );
      up.on("error", () => req.socket.destroy());
      up.end(Buffer.concat(chunks));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = (server.address() as net.AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    hits,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      record(`refusing proxy 127.0.0.1:${port} -> ${rule.status} for ${rule.method} ${rule.path}`, hits.map((h) => `${h.method} ${h.path}`).join("\n"), "", "closed");
    },
  };
}

/** A server that accepts every connection and never answers (`hold`, a dead link), or closes each at once (`drop`, a server that is down). */
export async function stallServer(mode: "hold" | "drop" = "hold"): Promise<Counted> {
  const hits: Counted["hits"] = [];
  const sockets = new Set<net.Socket>();
  const server = net.createServer((s) => {
    sockets.add(s);
    hits.push({ method: "connect", path: "" });
    s.on("error", () => undefined);
    s.on("close", () => sockets.delete(s));
    if (mode === "drop") s.destroy();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = (server.address() as net.AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    hits,
    close: async () => {
      sockets.forEach((s) => s.destroy());
      await new Promise<void>((resolve) => server.close(() => resolve()));
      record(`stall server (${mode}) 127.0.0.1:${port}`, `${hits.length} connections`, "", "closed");
    },
  };
}

/**
 * A machine that talks to `serverUrl` (a proxy) with the key of "box-2", and the session of `from` copied to it: the same lease
 * under the same sid, so a command through the proxy needs no session start of its own.
 */
export async function machineVia(serverUrl: string, key: string, from: CliMachine, sid: string): Promise<CliMachine> {
  const m = await installedMachine(serverUrl, "box-2", key);
  fs.mkdirSync(path.join(m.configDir, "sessions"), { recursive: true, mode: 0o700 });
  fs.writeFileSync(m.sessionPath(sid), fs.readFileSync(from.sessionPath(sid)), { mode: 0o600 });
  return m;
}
