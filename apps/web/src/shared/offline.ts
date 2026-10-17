// The offline cache database (IndexedDB), opened once on first use; null where the browser has none or refuses it.
import { forgetOfflineData, openOfflineCache, type CacheDb } from "@convoz/api-client";

let opened: Promise<CacheDb | null> | undefined;

/** offline is the one open cache database. */
export const offline = (): Promise<CacheDb | null> => (opened ??= openOfflineCache());

/** forgetOffline empties it: the person signed out, or the device was revoked. */
export const forgetOffline = (): Promise<void> => forgetOfflineData(offline());
