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
