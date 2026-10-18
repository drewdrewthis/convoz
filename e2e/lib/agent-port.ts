import type { ServerHandle, ServerOptions } from "./fixtures.ts";
import { send, type Res, type ReqOpts, type Target } from "./http.ts";
import { must, ownerOf, type Owner } from "./owner.ts";

/**
 * Helpers for the agents-only listener (`--agent-listen` + `--agent-host`). The test build names both listeners "localhost",
 * because a Funnel name cannot be dialled; the agent port is the one the ready file reports.
 */

/** A server with the agents-only listener on a free loopback port. */
export const agentServer = (extra: ServerOptions & { strict?: boolean } = {}): ServerOptions => ({
  host: "localhost",
  adminSocket: true,
  // The real CLI has no Funnel proxy in front of it, so the test build may know a client by its peer address (CONVOZ_TEST_AGENT_PEER).
  // `strict` turns that off: the server then refuses what a release build refuses.
  env: { CONVOZ_TEST_POLL_MS: "250", ...(extra.strict ? {} : { CONVOZ_TEST_AGENT_PEER: "1" }), ...(extra.env ?? {}) },
  ...Object.fromEntries(Object.entries(extra).filter(([k]) => k !== "strict" && k !== "env")),
  extraArgs: ["--agent-listen", "127.0.0.1:0", "--agent-host", "localhost", ...(extra.extraArgs ?? [])],
});

export interface AgentPort {
  /** For `send`: the agent listener, with the Host the server expects. */
  target: Target;
  /** What agents are told to use: http://localhost:<agent port>. */
  origin: string;
  port: number;
}

/** The agent listener of a running server, from its ready file. */
export function agentPort(srv: ServerHandle): AgentPort {
  const url = (srv.ready as { agent?: string }).agent;
  if (!url) throw new Error("the server has no agent listener: start it with agentServer()");
  const port = Number(url.slice(url.lastIndexOf(":") + 1));
  const origin = `http://localhost:${port}`;
  return { target: { tcpPort: port, host: "localhost", origin }, origin, port };
}

/** One request to the agent listener; `from` is the internet address the Funnel proxy would write into X-Forwarded-For (it also sets the Funnel marker). */
export function viaAgent(srv: ServerHandle, method: string, path: string, o: ReqOpts & { from?: string; bearer?: string } = {}): Promise<Res> {
  const { from, bearer, ...rest } = o;
  return send(agentPort(srv).target, method, path, {
    ...rest,
    headers: { ...(from ? { "X-Forwarded-For": from, "Tailscale-Funnel-Request": "?1" } : {}), ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}), ...(rest.headers ?? {}) },
  });
}

/** What an invite looks like on the wire: cvz_i_, the test marker, 43 characters. */
export const INVITE_RE = /cvz_i_[A-Za-z0-9]+/;

export interface InviteRow {
  id: number;
  hint: string;
  maker: string;
  maker_is_owner: boolean;
  conversation_id?: number;
  note: string;
  created_at: number;
  expires_at: number;
  token?: string;
  server?: string;
  login?: string;
}

/** `POST /api/invites` with a credential: the owner's session, or an agent's lease. Returns the raw answer. */
export function makeInvite(who: { owner: Owner } | { srv: ServerHandle; lease: string }, body: { conversation_id?: number; note?: string } = {}): Promise<Res> {
  if ("owner" in who) return who.owner.client.post("/api/invites", body);
  return send(who.srv.target, "POST", "/api/invites", { json: body, headers: { Authorization: `Bearer ${who.lease}` } });
}

/** A one-use invite made by the owner. */
export async function ownerInvite(owner: Owner, body: { conversation_id?: number; note?: string } = {}): Promise<string> {
  const made = must(await makeInvite({ owner }, body), "make an invite", 201).json().invite as InviteRow;
  return made.token!;
}

/** `GET /api/invites` as the owner: the open ones. */
export async function openInvites(owner: Owner): Promise<InviteRow[]> {
  return must(await owner.client.get("/api/invites"), "list invites").json().invites as InviteRow[];
}

/** The actions in the owner's audit view, newest first. */
export async function auditActions(owner: Owner): Promise<string[]> {
  return (must(await owner.client.get("/api/admin/audit"), "audit view").json().audit as { action: string }[]).map((r) => r.action);
}

/**
 * `POST /api/device/code` on the agent listener, as the CLI sends it. An internet request needs an invite: by default the owner of the
 * server (the one `bootstrapOwner` made) makes one for this call. Pass a token for a chosen invite, or null to send none.
 */
export async function startLoginViaAgent(
  srv: ServerHandle,
  name: string,
  from?: string,
  identity?: Record<string, unknown>,
  invite?: string | null,
): Promise<Res> {
  let token = invite ?? undefined;
  if (invite === undefined) {
    const owner = ownerOf(srv);
    if (!owner) throw new Error("startLoginViaAgent: the owner makes the invite, so bootstrap the owner first (or pass an invite, or null for none)");
    token = await ownerInvite(owner);
  }
  return viaAgent(srv, "POST", "/api/device/code", {
    ...(from ? { from } : {}),
    json: {
      name,
      host_info: { hostname: `${name}.TESTONLY.local`, os: "linux", arch: "amd64", cli_version: "0.0.0-TESTONLY" },
      ...(identity ? { identity } : {}),
      ...(token ? { invite: token } : {}),
    },
  });
}
