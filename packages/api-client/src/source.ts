// Where the shared data cache gets its data. Today it is the network; the IndexedDB cache (db/) and the cursor delta of
// the sync engine stand behind the same interface later, so the cache and every feature stay as they are.
import type { Conversation, Identity, Me, Message, Posted } from "./types.ts";

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
  /** Post with a client id made once per message: a retry with the same id never makes a second one. */
  post(id: number, clientId: string, body: string): Promise<Posted>;
  /** Move the read cursor; true when the server took it. Never throws: a lost cursor is sent again later.
   *  `keepalive` lets the request outlive the page (it is leaving). */
  markRead(id: number, mainId: number, keepalive?: boolean): Promise<boolean>;
}
