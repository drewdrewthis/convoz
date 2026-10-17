// What the owner can do to a message from the page. Each call is one request; the live frame that follows updates the log.
import type { EditHistory } from "@convoz/api-client";
import { call, client } from "../../../shared/api.ts";
import { newId } from "../../../shared/chat.ts";

export const editMessage = (id: number, body: string) =>
  call(client.PATCH("/api/messages/{id}", { params: { path: { id } }, body: { client_id: newId(), body } }));

export const deleteMessage = (id: number) => call(client.DELETE("/api/messages/{id}", { params: { path: { id } } }));

export const editHistory = (id: number): Promise<EditHistory> => call(client.GET("/api/messages/{id}/edits", { params: { path: { id } } }));
