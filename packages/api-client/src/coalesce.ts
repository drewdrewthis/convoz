/** coalesce makes fn run one at a time: calls that arrive while it runs become one more run. */
export function coalesce(fn: () => Promise<void>): () => Promise<void> {
  let running = false;
  let again = false;
  return async function run() {
    if (running) {
      again = true;
      return;
    }
    running = true;
    try {
      do {
        again = false;
        await fn();
      } while (again);
    } catch {
      /* the next resume or frame tries again */
    } finally {
      running = false;
    }
  };
}
