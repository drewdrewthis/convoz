// Pin and unpin one message, for the owner only (I-22). The conversation row is read again: it holds the list of pins.
import { call, client } from "../../shared/api.ts";
import { data } from "../../shared/data.ts";

export async function pinMessage(conversation: number, id: number): Promise<void> {
  await call(client.PUT("/api/messages/{id}/pin", { params: { path: { id } }, body: {} }));
  await data.loadConversation(conversation);
}

export async function unpinMessage(conversation: number, id: number): Promise<void> {
  await call(client.DELETE("/api/messages/{id}/pin", { params: { path: { id } } }));
  await data.loadConversation(conversation);
}
