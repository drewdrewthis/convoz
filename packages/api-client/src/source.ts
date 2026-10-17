// Where the shared data cache and the sync engine get their data: the network, through the generated client.
import type { Conversation, Identity, Me, Message, Posted, SyncAnswer, SyncSnapshot } from "./types.ts";

export interface MessagePage {
  messages: Message[];
}

export interface DataSource {
  me(): Promise<Me>;
  identities(): Promise<Identity[]>;
  conversations(): Promise<Conversation[]>;
  conversation(id: number): Promise<Conversation>;
  createConversation(clientId: string, participants: string[]): Promise<Conversation>;
  /** A page of messages, oldest first: the newest page, or the page before or after an id. */
  messages(id: number, cursor: { before?: number; after?: number; limit: number }): Promise<MessagePage>;
  /** Post with a client id made once per message: a retry with the same id never makes a second one. `uploadIds` are finished
   *  uploads the message carries; the body may be empty when there are some. */
  post(id: number, clientId: string, body: string, uploadIds?: string[]): Promise<Posted>;
  /** Move the read cursor; true when the server took it. Never throws: a lost cursor is sent again later.
   *  `keepalive` lets the request outlive the page (it is leaving). */
  markRead(id: number, mainId: number, keepalive?: boolean): Promise<boolean>;
  /** Where the event log stands now (GET /api/sync/snapshot). */
  snapshot(): Promise<SyncSnapshot>;
  /** The events after a cursor (GET /api/sync); with `wait` seconds the server holds the request when nothing is new. */
  delta(cursor: string, wait?: number, signal?: AbortSignal): Promise<SyncAnswer>;
}
