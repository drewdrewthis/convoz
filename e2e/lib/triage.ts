import type { ServerHandle, ServerOptions } from "./fixtures.ts";
import { chatWorld, createConversation, startSession } from "./chat.ts";
import type { Res } from "./http.ts";
import { stepped } from "./machines.ts";
import { asAgent, idsOf } from "./wp3.ts";

/**
 * Background of triage.feature: owner "drew", agents "devtool", "triage" and "docs", machine "box-2" (allows all three), conversation 41
 * "Ship search filters" with "devtool" only, and a live session each for "devtool", "triage" and "docs". Neither "triage" nor "docs" is in
 * conversation 41.
 */
export interface TriageWorld {
  w: World;
  ids: Record<string, number>;
  conv: number;
  dev: { sid: string; lease: string };
  tri: { sid: string; lease: string };
  doc: { sid: string; lease: string };
}

type World = Awaited<ReturnType<typeof chatWorld>>;
type Server = (o?: ServerOptions) => Promise<ServerHandle>;

export async function triageWorld(server: Server, o: { env?: Record<string, string> } = {}): Promise<TriageWorld> {
  const w = await chatWorld(server, { agents: ["devtool", "triage", "docs"], ...(o.env ? { env: o.env } : {}) });
  const conv = await createConversation(w.owner, { title: "Ship search filters", participants: ["devtool"] });
  const dev = await startSession(w.box, "devtool", "dev");
  const tri = await startSession(w.box, "triage", "triage");
  const doc = await startSession(w.box, "docs", "docs");
  return { w, ids: await idsOf(w.owner), conv, dev, tri, doc };
}

/** `PUT /api/agents/:id/triage` as the owner, with its own passkey check. The raw answer. */
export function setTriage(r: Pick<TriageWorld, "w" | "ids">, on: boolean, handle = "triage"): Promise<Res> {
  const id = r.ids[handle]!;
  return stepped(r.w.owner, "PUT", `/api/agents/${id}/triage`, { on }, "identity.triage", id);
}

/** The owner makes "triage" a triage agent; it must be stored. */
export async function grantTriage(r: Pick<TriageWorld, "w" | "ids">): Promise<void> {
  const res = await setTriage(r, true);
  if (res.status !== 200) throw new Error(`grant triage: ${res.status} ${res.text}`);
}

/** `POST /api/conversations/:id/participants` as an agent: adds the agent `target` (an identity id). */
export function agentAdds(srv: ServerHandle, lease: string, conv: number, target: number): Promise<Res> {
  return asAgent(srv, lease, "POST", `/api/conversations/${conv}/participants`, { identity_id: target });
}

/** `DELETE /api/conversations/:id/participants/:iid` as an agent. */
export function agentRemoves(srv: ServerHandle, lease: string, conv: number, target: number): Promise<Res> {
  return asAgent(srv, lease, "DELETE", `/api/conversations/${conv}/participants/${target}`);
}

/** `POST /api/conversations/:id/join-requests` as an agent. */
export function agentJoins(srv: ServerHandle, lease: string, conv: number): Promise<Res> {
  return asAgent(srv, lease, "POST", `/api/conversations/${conv}/join-requests`, {});
}
