/**
 * coalesce makes fn run one at a time: calls that arrive while it runs become one more run. Every call resolves once a run that
 * started after it has finished, so a caller that awaits it reads what fn wrote (keepForOffline reads the list right after it).
 */
export function coalesce(fn: () => Promise<void>): () => Promise<void> {
  let running: Promise<void> | null = null;
  let again = false;
  return function run() {
    if (running) {
      again = true;
      return running;
    }
    running = (async () => {
      try {
        do {
          again = false;
          await fn();
        } while (again);
      } catch {
        /* the next resume or frame tries again */
      } finally {
        running = null;
      }
    })();
    return running;
  };
}

/** coalescePer is coalesce with one run slot per key: a burst of calls for one conversation becomes at most two runs, other keys do not wait. */
export function coalescePer<K>(fn: (key: K) => Promise<void>): (key: K) => Promise<void> {
  const runs = new Map<K, () => Promise<void>>();
  return (key) => {
    let run = runs.get(key);
    if (!run) runs.set(key, (run = coalesce(() => fn(key))));
    return run();
  };
}

/**
 * debouncePer runs fn(key) once `ms` after the last call for that key, so a burst spread over a second (a slow runner, a catch-up) is one
 * run, where coalescePer would still run again for each call that lands while a run is on its way. `maxWait` bounds the wait: a key
 * pending that long runs even if calls keep coming, so a steady stream cannot starve it.
 */
export function debouncePer<K>(fn: (key: K) => Promise<void> | void, ms: number, maxWait = 1000): (key: K) => void {
  const pending = new Map<K, { timer: ReturnType<typeof setTimeout>; since: number }>();
  return (key) => {
    const now = Date.now();
    const prev = pending.get(key);
    clearTimeout(prev?.timer);
    const since = prev?.since ?? now;
    const wait = Math.max(0, Math.min(ms, since + maxWait - now));
    pending.set(key, {
      since,
      timer: setTimeout(() => {
        pending.delete(key);
        void Promise.resolve(fn(key)).catch(() => {});
      }, wait),
    });
  };
}
