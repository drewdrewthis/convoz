// What the owner can do to a message from the page. Each call is one request; the live frame that follows updates the log.
import type { EditHistory, UnfurlCard } from "@convoz/api-client";
import { call, client } from "../../../shared/api.ts";
import { newId } from "../../../shared/chat.ts";

export const editMessage = (id: number, body: string) =>
  call(client.PATCH("/api/messages/{id}", { params: { path: { id } }, body: { client_id: newId(), body } }));

export const deleteMessage = (id: number) => call(client.DELETE("/api/messages/{id}", { params: { path: { id } } }));

export const editHistory = (id: number): Promise<EditHistory> => call(client.GET("/api/messages/{id}/edits", { params: { path: { id } } }));

/** The preview card of a message's first link. Throws ApiError 404 when the message has no card (unfurls off for the host, or no link). */
export const unfurlOf = (id: number): Promise<UnfurlCard> => call(client.GET("/api/messages/{id}/unfurl", { params: { path: { id } } }));

/** Puts a voice note back in the transcript queue; the live frame that follows shows it as pending. */
export const transcribeAgain = (uploadId: string) => call(client.POST("/api/uploads/{id}/transcribe", { params: { path: { id: uploadId } } }));
