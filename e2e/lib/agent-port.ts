import type { ServerHandle, ServerOptions } from "./fixtures.ts";
import { send, type Res, type ReqOpts, type Target } from "./http.ts";

/**
 * Helpers for the agents-only listener (`--agent-listen` + `--agent-host`). The test build names both listeners "localhost",
 * because a Funnel name cannot be dialled; the agent port is the one the ready file reports.
 */

/** A server with the agents-only listener on a free loopback port. */
export const agentServer = (extra: ServerOptions = {}): ServerOptions => ({
  host: "localhost",
  adminSocket: true,
  env: { CONVOZ_TEST_POLL_MS: "250", ...(extra.env ?? {}) },
  ...extra,
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

/** One request to the agent listener; `from` is the internet address the Funnel proxy would write into X-Forwarded-For. */
export function viaAgent(srv: ServerHandle, method: string, path: string, o: ReqOpts & { from?: string; bearer?: string } = {}): Promise<Res> {
  const { from, bearer, ...rest } = o;
  return send(agentPort(srv).target, method, path, {
    ...rest,
    headers: { ...(from ? { "X-Forwarded-For": from } : {}), ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}), ...(rest.headers ?? {}) },
  });
}

/** `POST /api/device/code` on the agent listener, as the CLI sends it. */
export function startLoginViaAgent(srv: ServerHandle, name: string, from?: string): Promise<Res> {
  return viaAgent(srv, "POST", "/api/device/code", {
    ...(from ? { from } : {}),
    json: { name, host_info: { hostname: `${name}.TESTONLY.local`, os: "linux", arch: "amd64", cli_version: "0.0.0-TESTONLY" } },
  });
}
