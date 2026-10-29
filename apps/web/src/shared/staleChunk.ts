// A deploy replaces the hashed chunks, so a tab on the old build fails to load its next chunk. One reload fetches the new build.
const KEY = "convoz.staleChunkReloadAt";
const WINDOW = 60_000;

type Flag = Pick<Storage, "getItem" | "setItem">;

/** mayReload records the reload and says yes, unless one happened in the last 60 s (a loop guard: a chunk missing on the new build too would reload forever). */
export function mayReload(flag: Flag, now: number): boolean {
  const last = Number(flag.getItem(KEY));
  if (last && now - last < WINDOW) return false;
  flag.setItem(KEY, String(now));
  return true;
}

/** reloadOnStaleChunk reloads the page once when Vite cannot load a chunk. */
export function reloadOnStaleChunk(): void {
  addEventListener("vite:preloadError", (event) => {
    event.preventDefault();
    try {
      if (mayReload(sessionStorage, Date.now())) location.reload();
    } catch {
      /* no storage: do not reload, so it cannot loop */
    }
  });
}
