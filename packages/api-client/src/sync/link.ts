// The live link to the server: the event stream (GET /api/stream), and the long poll (GET /api/sync?wait=25) it falls back
// to when the stream keeps failing (design §12.3).
//
// The stream is a native EventSource, so the browser resumes a dropped one by itself with Last-Event-ID. Two failures inside a
// minute mean the path does not carry streams (a proxy that buffers, a NAT that cuts idle connections): the link then closes
// the EventSource and polls, and tries the stream again now and then, backing off with full jitter from 1 s up to 30 s. When a
// stream opens, the polling stops.
import type { Frame, FrameName } from "../types.ts";
import { parseCursor, type Cursor } from "./cursor.ts";

/** Where a stored frame sits in the log, and where the frame before it sat (`prev_seq_for_you`). Live-only frames have none. */
export interface Place {
  cursor: Cursor;
  prev: number;
}

export interface LinkHandlers {
  /** A frame of the stream, in order. */
  onFrame(frame: Frame, at: Place | null): void;
  /** A stream is open (the first one, or one that came back): read what was missed meanwhile. */
  onOpen(): void;
  /** The server said to drop what was held of the stream and load a snapshot. */
  onReset(): void;
  /** One long poll. It resolves when the poll ends and throws when it fails, which makes the link wait before the next one. */
  poll(signal: AbortSignal): Promise<void>;
}

export interface Link {
  /** The app came back (online, visible, shown from the cache): reopen a stream the phone closed, or try the stream now. */
  ensure(): void;
  close(): void;
}

export interface LinkOptions {
  url?: string;
  /** The EventSource class, for a test. */
  eventSource?: typeof EventSource;
  now?: () => number;
  random?: () => number;
}

/** Two failures within this long mean the stream does not work on this link. */
const FAILURE_WINDOW_MS = 60_000;
const FAILURES_TO_POLL = 2;
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_CAP_MS = 30_000;
/** A refused stream (not a dropped link): the browser gives up on it, so we try again after this. */
const REFUSED_RETRY_MS = 3_000;

/** backoff is the wait before attempt `n` (0 first): a random time from 0 to base * 2^n, at most the cap (full jitter). */
export const backoff = (n: number, random: () => number = Math.random): number => random() * Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** n);

/** openLink opens the stream for the named frames. */
export function openLink<N extends FrameName>(names: readonly N[], on: LinkHandlers, o: LinkOptions = {}): Link {
  const url = o.url ?? "/api/stream";
  const Source = o.eventSource ?? EventSource;
  const now = o.now ?? Date.now;
  const random = o.random ?? Math.random;
  let es: EventSource | null = null;
  let closed = false;
  let polling = false;
  let failures: number[] = [];
  let probes = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pollAbort: AbortController | null = null;

  const pause = (ms: number, signal: AbortSignal) =>
    new Promise<void>((resolve) => {
      const t = setTimeout(resolve, ms);
      signal.addEventListener("abort", () => (clearTimeout(t), resolve()), { once: true });
    });

  async function pollLoop(signal: AbortSignal) {
    let bad = 0;
    while (!signal.aborted) {
      try {
        await on.poll(signal);
        bad = 0;
      } catch {
        if (signal.aborted) return;
        await pause(backoff(bad++, random), signal);
      }
    }
  }

  const stopPolling = () => {
    polling = false;
    pollAbort?.abort();
    pollAbort = null;
  };

  const startPolling = () => {
    es?.close();
    es = null;
    polling = true;
    pollAbort = new AbortController();
    void pollLoop(pollAbort.signal);
    probeLater();
  };

  /** While polling, the stream is tried again after a growing, jittered wait. */
  const probeLater = () => {
    clearTimeout(timer);
    timer = setTimeout(connect, backoff(probes++, random));
  };

  function connect() {
    clearTimeout(timer);
    if (closed) return;
    es?.close();
    const mine = new Source(url);
    es = mine;
    mine.addEventListener("open", () => {
      if (es !== mine) return;
      failures = [];
      probes = 0;
      stopPolling();
      on.onOpen();
    });
    mine.addEventListener("error", () => {
      if (es !== mine || closed) return;
      const t = now();
      failures = [...failures.filter((at) => t - at < FAILURE_WINDOW_MS), t];
      if (polling) {
        mine.close(); // a probe failed: back off before the next
        es = null;
        probeLater();
      } else if (failures.length >= FAILURES_TO_POLL) {
        startPolling();
      } else if (mine.readyState === Source.CLOSED) {
        timer = setTimeout(connect, REFUSED_RETRY_MS);
      }
    });
    mine.addEventListener("reset", () => {
      if (es !== mine) return;
      on.onReset();
      connect(); // a fresh stream from the end of the log; the reset's snapshot covers the gap
    });
    for (const name of names) {
      mine.addEventListener(name, (event) => {
        let data: unknown;
        try {
          data = JSON.parse((event as MessageEvent<string>).data);
        } catch {
          return;
        }
        const cursor = parseCursor((event as MessageEvent<string>).lastEventId);
        const prev = (data as { prev_seq_for_you?: unknown }).prev_seq_for_you;
        on.onFrame({ name, data } as Frame, cursor && typeof prev === "number" ? { cursor, prev } : null);
      });
    }
  }

  connect();
  return {
    ensure() {
      if (closed) return;
      if (polling) connect(); // try the stream now, the phone may have a better link
      else if (!es || es.readyState === Source.CLOSED) connect();
    },
    close() {
      closed = true;
      clearTimeout(timer);
      stopPolling();
      es?.close();
      es = null;
    },
  };
}
