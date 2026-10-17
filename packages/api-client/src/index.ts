// @convoz/api-client: the typed client of the Convoz API, the shared data cache, and the sync engine that feeds it.
export * from "./types.ts";
export { createConvozClient, type ConvozClient } from "./client.ts";
export { openStream, type Stream } from "./stream.ts";
export { coalesce } from "./coalesce.ts";
export type { DataSource, MessagePage } from "./source.ts";
export { createDataCache, LIMIT, maxId, type DataCache, type DataState, type MessageList } from "./cache.ts";
export { dispatch, registerHandler, registerResync, type FrameHandler } from "./handlers.ts";
export { createSync, type Sync } from "./sync.ts";
export { memoryOutbox, type Outbox, type OutboxItem } from "./outbox.ts";
