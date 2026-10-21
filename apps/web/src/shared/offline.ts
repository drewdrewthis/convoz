// The offline cache database (IndexedDB), opened once on first use; null where the browser has none or refuses it.
import { forgetOfflineData, openOfflineCache, type CacheDb } from "@convoz/api-client";

let opened: Promise<CacheDb | null> | undefined;

/** offline is the one open cache database. */
export const offline = (): Promise<CacheDb | null> => (opened ??= openOfflineCache());

/** forgetOffline empties it and this tab's sessionStorage (the unsent drafts): the person signed out, or the device was revoked. */
export function forgetOffline(): Promise<void> {
  try {
    sessionStorage.clear();
  } catch {
    // a store that cannot be read holds nothing to forget
  }
  return forgetOfflineData(offline());
}

/** remember keeps one small fact (the last Now, the last sync time) in the `meta` store. A refusing disk loses it, nothing more. */
export async function remember(key: string, value: unknown): Promise<void> {
  try {
    await (await offline())?.put("meta", value, key);
  } catch {
    /* the offline copy is a convenience */
  }
}

/** recall reads what remember kept; undefined when there is none. */
export async function recall<T>(key: string): Promise<T | undefined> {
  try {
    return (await (await offline())?.get("meta", key)) as T | undefined;
  } catch {
    return undefined;
  }
}
