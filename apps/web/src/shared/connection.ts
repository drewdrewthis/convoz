// How the link to the server is doing, for the offline banner and Settings → Advanced → Connection (design §9, §12.3).
// `offline` is true while the browser says it is offline or the last request could not reach the server; `syncedAt` is when a
// read last got an answer, kept in IndexedDB so the banner can still say it after a restart.
import { create } from "zustand";
import { recall, remember } from "./offline.ts";

/** The samples Settings lists. */
const KEEP_SAMPLES = 20;

interface ConnectionState {
  offline: boolean;
  /** When a read last got an answer (epoch ms); null before the first. */
  syncedAt: number | null;
  /** Round trips of /api/ping, oldest first (ms). */
  samples: number[];
}

export const useConnection = create<ConnectionState>()(() => ({ offline: typeof navigator !== "undefined" && navigator.onLine === false, syncedAt: null, samples: [] }));

const set = useConnection.setState;
let saving: ReturnType<typeof setTimeout> | undefined;
let unsaved: number | null = null;

/** The sync time is written at once and then at most once a second, and when the page goes away, so a quick offline start still has it. */
function save(at: number): void {
  if (saving) {
    unsaved = at;
    return;
  }
  void remember("syncedAt", at);
  saving = setTimeout(() => {
    saving = undefined;
    if (unsaved !== null) save(unsaved);
    unsaved = null;
  }, 1_000);
}

/** reachable notes that the server answered (any answer: a refusal still means the link works). */
export function reachable(ok: boolean): void {
  if (useConnection.getState().offline) set({ offline: false });
  if (!ok) return;
  const at = Date.now();
  set({ syncedAt: at });
  save(at);
}

/** unreachable notes that a request got no answer, or that the cached copy had to stand in for it. */
export const unreachable = (): void => set({ offline: true });

/** sampled adds one round trip to the list. */
export const sampled = (ms: number): void => set((s) => ({ samples: [...s.samples, ms].slice(-KEEP_SAMPLES) }));

/** median is the middle sample (0 for none). */
export function median(samples: number[]): number {
  if (!samples.length) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

/** effectiveType is what the browser guesses of the link ("4g", "3g", ...); "unknown" where it has no such API (iOS Safari). */
export const effectiveType = (): string => (navigator as Navigator & { connection?: { effectiveType?: string } }).connection?.effectiveType ?? "unknown";

if (typeof window !== "undefined") {
  addEventListener("offline", unreachable);
  addEventListener("online", () => set({ offline: false }));
  addEventListener("pagehide", () => {
    if (unsaved !== null) void remember("syncedAt", unsaved);
  });
  void recall<number>("syncedAt").then((at) => {
    if (at && !useConnection.getState().syncedAt) set({ syncedAt: at });
  });
}
