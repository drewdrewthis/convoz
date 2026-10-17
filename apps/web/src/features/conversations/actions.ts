// What the owner can do to a conversation from its details: one function per route, each followed by a reload of the row.
import { call, client } from "../../shared/api.ts";
import { data } from "../../shared/data.ts";

const reload = (id: number) => data.loadConversation(id).then(() => undefined);

/** addAgent brings an agent in at once; `history` says what it sees (the whole conversation, or only what comes after). */
export async function addAgent(id: number, identityId: number, history: "since_now" | "full"): Promise<void> {
  await call(client.POST("/api/conversations/{id}/participants", { params: { path: { id } }, body: { identity_id: identityId, history } }));
  await reload(id);
}

/** removeAgent takes an agent out; it gets one notice and nothing more. */
export async function removeAgent(id: number, iid: number): Promise<void> {
  await call(client.DELETE("/api/conversations/{id}/participants/{iid}", { params: { path: { id, iid } } }));
  await reload(id);
}

/** decideAdd approves or declines an add an agent asked for. */
export async function decideAdd(id: number, iid: number, approve: boolean): Promise<void> {
  const path = approve ? "/api/conversations/{id}/participants/{iid}/approve" : "/api/conversations/{id}/participants/{iid}/decline";
  await call(client.POST(path, { params: { path: { id, iid } }, body: {} }));
  await reload(id);
}

export async function rename(id: number, title: string): Promise<void> {
  await call(client.PATCH("/api/conversations/{id}", { params: { path: { id } }, body: { title } }));
  await reload(id);
}

export async function openPickup(id: number): Promise<void> {
  await call(client.POST("/api/conversations/{id}/pickup/open", { params: { path: { id } }, body: {} }));
  await reload(id);
}

export async function resume(id: number): Promise<void> {
  await call(client.POST("/api/conversations/{id}/resume", { params: { path: { id } }, body: {} }));
  await reload(id);
}

/** markAllRead clears the unread count and the bold title of one conversation. */
export async function markAllRead(id: number): Promise<void> {
  await call(client.POST("/api/conversations/{id}/read", { params: { path: { id } }, body: { main_id: 0, all: true } }));
  await data.loadConversations();
}

/** deleteConversation moves a conversation to the trash. */
export async function deleteConversation(id: number): Promise<void> {
  await call(client.DELETE("/api/conversations/{id}", { params: { path: { id } } }));
}

export async function restore(id: number): Promise<void> {
  await call(client.POST("/api/conversations/{id}/restore", { params: { path: { id } }, body: {} }));
}
