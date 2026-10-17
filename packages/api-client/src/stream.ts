// The SSE client of GET /api/stream. The sync engine (sync.ts) is its one user.
import type { Frame, FrameName } from "./types.ts";

export interface Stream {
  /** Reopen a stream the phone closed without telling us. */
  ensure(): void;
  close(): void;
}

/**
 * openStream keeps one EventSource('/api/stream') for the named frames. The browser reconnects on its own with
 * Last-Event-ID; onResync runs when the stream is open again after an error, so the caller can catch up what it missed.
 */
export function openStream<N extends FrameName>(
  names: readonly N[],
  onFrame: (frame: Frame<N>) => void,
  onResync: () => void,
  url = "/api/stream",
): Stream {
  let es: EventSource | null = null;
  let failed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const connect = () => {
    clearTimeout(timer);
    const mine = new EventSource(url);
    es = mine;
    mine.addEventListener("open", () => {
      if (failed) {
        failed = false;
        onResync();
      }
    });
    mine.addEventListener("error", () => {
      failed = true;
      if (mine.readyState === EventSource.CLOSED) timer = setTimeout(connect, 3000); // refused (not a dropped link): try later
    });
    for (const name of names) {
      mine.addEventListener(name, (event) => {
        let data: unknown;
        try {
          data = JSON.parse((event as MessageEvent<string>).data);
        } catch {
          return;
        }
        onFrame({ name, data } as Frame<N>);
      });
    }
  };
  connect();
  return {
    ensure() {
      if (!es || es.readyState === EventSource.CLOSED) connect();
    },
    close() {
      clearTimeout(timer);
      es?.close();
    },
  };
}
