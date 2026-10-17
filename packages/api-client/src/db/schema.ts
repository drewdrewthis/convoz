// The client cache in IndexedDB: every object store, at version 1. No work package bumps the version; a new store goes
// through the integrator (full-app plan §2). The cache is cleared on sign-out (Clear-Site-Data) and on a 401 whose code is
// device_revoked or session_expired, never on other errors (design §10, poor connections).
import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import type { Conversation, Identity, Me, Message } from "../types.ts";
import type { OutboxItem } from "../outbox.ts";

export const DB_NAME = "convoz";
export const DB_VERSION = 1;

/** The stores and their indexes. Values the server sends are stored as sent; the rest are the client's own records. */
export interface ConvozDB extends DBSchema {
  /** Who is signed in (one row, key "me"). */
  me: { key: string; value: Me };
  identities: { key: number; value: Identity; indexes: { handle: string } };
  conversations: { key: number; value: Conversation; indexes: { activity: number } };
  /** Messages by id; a conversation's page is a range of the conversation index. */
  messages: { key: number; value: Message & { conversation_id: number }; indexes: { conversation: [number, number] } };
  /** The sync cursor and other small facts (key → value). */
  meta: { key: string; value: unknown };
  outbox: { key: string; value: OutboxItem; indexes: { created: number } };
  /** Unsent composer text, by conversation key. */
  drafts: { key: string; value: { key: string; body: string; updatedAt: number } };
  /** Resumable uploads in flight: the committed offset and the file handle. */
  uploads: { key: string; value: { publicId: string; conversationId: number; offset: number; size: number; file: Blob } };
  /** Stars, mutes and the rail order of each conversation. */
  prefs: { key: number; value: { conversation_id: number; starred_at?: number; muted_until?: number; rail_rank?: number } };
  pins: { key: number; value: { message_id: number; conversation_id: number; created_at: number }; indexes: { conversation: number } };
  /** What waits on Now: open asks and machine requests. */
  now: { key: string; value: { id: string; kind: string; conversation_id?: number; created_at: number } };
  notifications: { key: number; value: { id: number; conversation_id: number; message_id: number; created_at: number; read_at?: number } };
  /** Device-local settings (design §11). */
  settings: { key: string; value: unknown };
}

/** STORES lists every store name, so a clear wipes them all. */
export const STORES = [
  "me", "identities", "conversations", "messages", "meta", "outbox", "drafts", "uploads", "prefs", "pins", "now", "notifications", "settings",
] as const satisfies readonly (keyof ConvozDB)[];

/** openCache opens (and on first use creates) the client cache. */
export function openCache(): Promise<IDBPDatabase<ConvozDB>> {
  return openDB<ConvozDB>(DB_NAME, DB_VERSION, {
    upgrade(db) {
      db.createObjectStore("me");
      db.createObjectStore("identities", { keyPath: "id" }).createIndex("handle", "handle", { unique: true });
      db.createObjectStore("conversations", { keyPath: "id" }).createIndex("activity", "last_activity_at");
      db.createObjectStore("messages", { keyPath: "id" }).createIndex("conversation", ["conversation_id", "id"]);
      db.createObjectStore("meta");
      db.createObjectStore("outbox", { keyPath: "cid" }).createIndex("created", "createdAt");
      db.createObjectStore("drafts", { keyPath: "key" });
      db.createObjectStore("uploads", { keyPath: "publicId" });
      db.createObjectStore("prefs", { keyPath: "conversation_id" });
      db.createObjectStore("pins", { keyPath: "message_id" }).createIndex("conversation", "conversation_id");
      db.createObjectStore("now", { keyPath: "id" });
      db.createObjectStore("notifications", { keyPath: "id" });
      db.createObjectStore("settings");
    },
  });
}

/** clearCache empties every store (sign-out, a revoking 401). */
export async function clearCache(db: IDBPDatabase<ConvozDB>): Promise<void> {
  const tx = db.transaction(STORES, "readwrite");
  await Promise.all([...STORES.map((name) => tx.objectStore(name).clear()), tx.done]);
}
