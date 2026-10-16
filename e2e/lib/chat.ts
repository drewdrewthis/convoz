import http from "node:http";
import { installedMachine, sidOf, type CliMachine, type Running } from "./cli.ts";
import type { ServerHandle, ServerOptions } from "./fixtures.ts";
import { Client, send, type Res } from "./http.ts";
import { allow, bearer, clientId, createAgents, loginMachine, type Allow, type LoggedIn } from "./machines.ts";
import { bootstrapOwner, must, type Owner } from "./owner.ts";
import { record } from "./transcript.ts";
import type { RunResult } from "./run.ts";

/**
 * Helpers for the chat scenarios (chat-api.spec.ts, chat-cli.spec.ts): the two actors, conversations, messages,
 * the owner's event stream and the agent's `convoz` commands. The routes, payloads and CLI output they rely on are in
 * the contract block at the top of tests/chat-api.spec.ts.
 *
 * Two actors: the owner is a real signed-in device (cookie client, passkey ceremony over HTTP); an agent is the real
 * `convoz` binary on machine "box-2", logged in through the device flow, acting through a lease (`session start`).
 */

const POLL = { CONVOZ_TEST_POLL_MS: "250" };

interface World {
  srv: ServerHandle;
  owner: Owner;
  box2: LoggedIn;
  /** The `convoz` CLI of machine "box-2", logged in with `box2.key`. */
  box: CliMachine;
}

/**
 * Background: a fresh server with owner "drew" signed in, the given agents, and machine "box-2" logged in with an
 * allow-list of those agents. Served under `localhost` so the CLI can reach it (`srv.origin`).
 */
export async function chatWorld(
  server: (o?: ServerOptions) => Promise<ServerHandle>,
  o: { agents: string[]; allowed?: Allow; env?: Record<string, string> },
): Promise<World> {
  const srv = await server({ host: "localhost", adminSocket: true, env: { ...POLL, ...(o.env ?? {}) } });
  const owner = await bootstrapOwner(srv);
  await createAgents(owner, ...o.agents);
  const box2 = await loginMachine(srv, owner, "box-2", o.allowed ?? allow(...o.agents));
  const box = await installedMachine(srv.origin, "box-2", box2.key);
  return { srv, owner, box2, box };
}

// ---- conversations and messages (owner, over HTTP) ----------------------------------------------------

interface ConversationRow {
  id: number;
  title: string | null;
  created_at: number;
  last_activity_at: number;
  participants: { handle: string; display_name: string; kind: string }[];
  last: { id: number; author_handle: string; preview: string } | null;
  unread: number;
}

interface MessageRow {
  id: number;
  author: { handle: string; display_name: string; kind: string };
  body: string;
  format: string;
  created_at: number;
}

/** `POST /api/conversations` as the owner: a conversation with the owner and the given agents. Returns its id. */
export async function createConversation(owner: Owner, o: { participants: string[]; title?: string; clientId?: string }): Promise<number> {
  const res = await owner.client.post("/api/conversations", {
    client_id: o.clientId ?? clientId(),
    ...(o.title !== undefined ? { title: o.title } : {}),
    participants: o.participants,
  });
  return must(res, "create conversation", 201).json().conversation.id as number;
}

/** `POST /api/conversations/:id/messages` as the owner. The raw answer. */
export function ownerPost(owner: Owner, conv: number, body: string, o: { clientId?: string; format?: string } = {}): Promise<Res> {
  return owner.client.post(`/api/conversations/${conv}/messages`, {
    client_id: o.clientId ?? clientId(),
    body,
    ...(o.format ? { format: o.format } : {}),
  });
}

/** The owner posts and it must be stored (201). Returns the message id. */
export async function ownerSays(owner: Owner, conv: number, body: string, o: { clientId?: string } = {}): Promise<number> {
  return must(await ownerPost(owner, conv, body, o), `owner posts ${JSON.stringify(body)}`, 201).json().id as number;
}

/** `POST /api/conversations/:id/messages` with a lease (an agent over HTTP). The raw answer. */
export function agentPost(srv: ServerHandle, leaseToken: string, conv: number, body: string, extra: Record<string, unknown> = {}): Promise<Res> {
  return send(srv.target, "POST", `/api/conversations/${conv}/messages`, { json: { client_id: clientId(), body, ...extra }, ...bearer(leaseToken) });
}

/** An agent over HTTP posts and it must be stored (201). Returns the message id. */
export async function agentSays(srv: ServerHandle, leaseToken: string, conv: number, body: string): Promise<number> {
  return must(await agentPost(srv, leaseToken, conv, body), `agent posts ${JSON.stringify(body)}`, 201).json().id as number;
}

/** `GET /api/conversations/:id/messages[?query]` as the owner: oldest first. */
export async function messagesOf(owner: Owner, conv: number, query = ""): Promise<MessageRow[]> {
  const res = await owner.client.get(`/api/conversations/${conv}/messages${query ? `?${query}` : ""}`);
  return must(res, `read conversation ${conv}`).json().messages as MessageRow[];
}

/** `GET /api/conversations` as the owner, in the order the server gives. */
export async function listConversations(owner: Owner): Promise<ConversationRow[]> {
  return must(await owner.client.get("/api/conversations"), "list conversations").json().conversations as ConversationRow[];
}

/** The unread count the list shows for one conversation. */
export async function unreadOf(owner: Owner, conv: number): Promise<number | undefined> {
  return (await listConversations(owner)).find((c) => c.id === conv)?.unread;
}

/** `POST /api/conversations/:id/read` as the owner. */
export async function ownerReads(owner: Owner, conv: number, mainId: number): Promise<void> {
  must(await owner.client.post(`/api/conversations/${conv}/read`, { main_id: mainId }), `owner reads ${conv} up to ${mainId}`);
}

// ---- agent sessions and commands ----------------------------------------------------------------------

interface AgentSession {
  sid: string;
  lease: string;
}

/** `convoz session start --as H` with its own client id (one lease per label). Returns the local sid and the lease. */
export async function startSession(box: CliMachine, as: string, label: string): Promise<AgentSession> {
  const res = await box.sessionStart(as, [], { claude: `claude-TESTONLY-${label}` });
  if (res.code !== 0) throw new Error(`session start as ${as}: exit ${res.code}\n${res.stderr}`);
  const sid = sidOf(res);
  return { sid, lease: box.leaseOf(sid) };
}

/** One `convoz <argv>` run with `--sid` and a CLI timeout. The command name goes first; its flags may stand anywhere after it. */
export function convoz(box: CliMachine, sid: string, argv: string[], stdin?: string): Promise<RunResult> {
  const [cmd = "", ...rest] = argv;
  return box.run([cmd, "--sid", sid, "--timeout", "10s", ...rest], { timeoutMs: 20_000, ...(stdin !== undefined ? { stdin } : {}) });
}

/** `convoz <cmd> --json ...` that must exit 0; returns the parsed stdout. */
async function convozJson<T = any>(box: CliMachine, sid: string, argv: string[]): Promise<T> {
  const [cmd = "", ...rest] = argv;
  const res = await convoz(box, sid, [cmd, "--json", ...rest]);
  if (res.code !== 0) throw new Error(`convoz ${argv.join(" ")}: exit ${res.code}\n${res.stderr}`);
  return JSON.parse(res.stdout) as T;
}

interface InboxItem {
  id: number;
  claim_token?: string;
  state?: string;
  reason: string;
  count: number;
  conversation: { id: number; title: string | null };
  message: { id: number; author: { handle: string }; body: string; created_at: number };
}

/** `convoz inbox --json <flags>`: the items. */
export async function inboxItems(box: CliMachine, sid: string, flags: string[]): Promise<InboxItem[]> {
  return (await convozJson<{ items: InboxItem[] }>(box, sid, ["inbox", ...flags])).items;
}

/** The inbox items of one conversation (`--peek`: nothing is claimed). */
export async function peekFor(box: CliMachine, sid: string, conv: number): Promise<InboxItem[]> {
  return (await inboxItems(box, sid, ["--peek"])).filter((i) => i.conversation.id === conv);
}

// ---- convoz watch --json ------------------------------------------------------------------------------

interface WatchLine {
  item_id: number;
  claim_token: string;
  reason: string;
  conversation_id: number;
  conversation_title: string | null;
  count: number;
  message_id: number;
  author: string;
  body: string;
  created_at: string | number;
}

/** Start `convoz watch --json` as a child. Stop it with `.stop()` in a finally block. */
export function startWatch(box: CliMachine, sid: string): Running {
  return box.start(["watch", "--json", "--sid", sid], { timeoutMs: 25_000 });
}

/** Wait until the stream holds `n` full lines; returns the first `n`, parsed. Rejects after `ms`. */
export async function watchLines(w: Running, n: number, ms = 5_000): Promise<WatchLine[]> {
  await w.waitForStdout(new RegExp(`^(?:[^\\n]*\\n){${n}}`), ms);
  return w
    .stdout()
    .split("\n")
    .slice(0, n)
    .map((l) => JSON.parse(l) as WatchLine);
}

/** Resolve with the run result if the child exits within `ms`, else `null` (the child keeps running). */
export async function exitsWithin(w: Running, ms: number): Promise<RunResult | null> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<null>((resolve) => (timer = setTimeout(() => resolve(null), ms)));
  try {
    return await Promise.race([w.done, late]);
  } finally {
    clearTimeout(timer);
  }
}

// ---- the owner's event stream (GET /api/stream) ---------------------------------------------------------

interface Frame {
  event: string;
  id?: string;
  data: any;
}

interface Stream {
  /** HTTP status of the stream response. */
  status: number;
  frames: Frame[];
  /** Resolve with the first frame (past or future) that matches; reject after `ms`. */
  waitFor(match: (f: Frame) => boolean, ms?: number): Promise<Frame>;
  /** Resolves when the server ends the stream (or the connection drops). */
  ended: Promise<void>;
  /** Close this stream (its own request handle). */
  close(): void;
}

/** Open `GET /api/stream` as the owner (cookie) and parse server-sent events. A non-200 answer gives a stream with that status and no frames. */
export function openStream(srv: ServerHandle, client: Client, path = "/api/stream"): Promise<Stream> {
  return new Promise((resolve, reject) => {
    const frames: Frame[] = [];
    const waiters = new Set<() => void>();
    let markEnded: () => void = () => {};
    const ended = new Promise<void>((r) => (markEnded = r));
    let raw = "";
    let buf = "";
    const req = http.request(
      {
        method: "GET",
        path,
        host: "127.0.0.1",
        port: srv.tcpPort,
        agent: false,
        headers: { Host: `${srv.host}:${srv.tcpPort}`, Accept: "text/event-stream", Cookie: client.cookieHeader() },
      },
      (res) => {
        res.setEncoding("utf8");
        res.on("close", markEnded);
        res.on("data", (chunk: string) => {
          raw += chunk;
          buf += chunk;
          let i: number;
          while ((i = buf.indexOf("\n\n")) >= 0) {
            const block = buf.slice(0, i);
            buf = buf.slice(i + 2);
            const f: Frame = { event: "message", data: undefined };
            const data: string[] = [];
            for (const line of block.split("\n")) {
              if (line.startsWith(":")) continue;
              if (line.startsWith("event:")) f.event = line.slice(6).trim();
              else if (line.startsWith("id:")) f.id = line.slice(3).trim();
              else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
            }
            if (data.length === 0) continue;
            try {
              f.data = JSON.parse(data.join("\n"));
            } catch {
              f.data = data.join("\n");
            }
            frames.push(f);
            waiters.forEach((w) => w());
          }
        });
        const status = res.statusCode ?? 0;
        if (status !== 200) res.resume();
        resolve({
          status,
          frames,
          ended,
          close: () => {
            record(`SSE GET ${path}`, raw, "", `status=${status}`);
            req.destroy();
          },
          waitFor: (match, ms = 5_000) =>
            new Promise<Frame>((ok, fail) => {
              const timer = setTimeout(() => done(new Error(`no matching frame in ${ms} ms; frames so far: ${JSON.stringify(frames)}`)), ms);
              const check = () => {
                const hit = frames.find(match);
                if (hit) done(undefined, hit);
              };
              const done = (err?: Error, f?: Frame) => {
                clearTimeout(timer);
                waiters.delete(check);
                if (err) fail(err);
                else ok(f!);
              };
              waiters.add(check);
              check();
            }),
        });
      },
    );
    // Not req.setTimeout: that is an idle timeout and would cut a quiet stream. Only the wait for headers is bounded.
    const headerTimer = setTimeout(() => req.destroy(new Error(`GET ${path}: no response headers in 10 s`)), 10_000);
    req.on("response", () => clearTimeout(headerTimer));
    req.on("error", (e) => {
      clearTimeout(headerTimer);
      reject(e); // after resolve this is a no-op (a closed stream ends with "socket hang up")
    });
    req.end();
  });
}
