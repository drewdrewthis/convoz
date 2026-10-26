import type { Identity as ApiIdentity } from "@convoz/api-client";

/** An identity as GET /api/identities lists it, the fields the panel reads. */
export type Identity = Pick<ApiIdentity, "kind" | "handle" | "disabled">;

/** activeAgents keeps the identities the panel offers: agents that are not disabled, in the server's order. */
export const activeAgents = <T extends Identity>(identities: T[]): T[] => identities.filter((i) => i.kind === "agent" && !i.disabled);
