import type { ServerHandle, ServerOptions } from "./fixtures.ts";
import { chatWorld, createConversation, startSession } from "./chat.ts";
import type { Res } from "./http.ts";
import { stepped } from "./machines.ts";
import { idsOf } from "./wp3.ts";

/**
 * Background of read-all.feature: owner "drew", agents "devtool", "triage" and "docs", machine "box-2" (allows all three), conversation 41
 * "Ship search filters" with "devtool" only, and a live session each for "devtool" and "triage". "triage" is not in conversation 41.
 */
export interface ReadAllWorld {
  w: World;
  ids: Record<string, number>;
  conv: number;
  dev: { sid: string; lease: string };
  tri: { sid: string; lease: string };
}

type World = Awaited<ReturnType<typeof chatWorld>>;
type Server = (o?: ServerOptions) => Promise<ServerHandle>;

export async function readAllWorld(server: Server, o: { env?: Record<string, string> } = {}): Promise<ReadAllWorld> {
  const w = await chatWorld(server, { agents: ["devtool", "triage", "docs"], ...(o.env ? { env: o.env } : {}) });
  const conv = await createConversation(w.owner, { title: "Ship search filters", participants: ["devtool"] });
  const dev = await startSession(w.box, "devtool", "dev");
  const tri = await startSession(w.box, "triage", "triage");
  return { w, ids: await idsOf(w.owner), conv, dev, tri };
}

/** `PUT /api/agents/:id/read-all` as the owner, with its own passkey check. The raw answer. */
export function setReadAll(r: Pick<ReadAllWorld, "w" | "ids">, on: boolean, handle = "triage"): Promise<Res> {
  const id = r.ids[handle]!;
  return stepped(r.w.owner, "PUT", `/api/agents/${id}/read-all`, { on }, "identity.read_all", id);
}

/** The owner turns reading everything on for "triage"; it must be stored. */
export async function grantReadAll(r: Pick<ReadAllWorld, "w" | "ids">): Promise<void> {
  const res = await setReadAll(r, true);
  if (res.status !== 200) throw new Error(`grant read-all: ${res.status} ${res.text}`);
}
