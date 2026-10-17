// The dispatch side of the sync engine: features listen to frames by name prefix. Many listeners may share one prefix
// ("message." for the transcript and the rail alike); each feature registers its own in its index.ts.
import type { Frame } from "./types.ts";

export type FrameHandler = (frame: Frame) => void;

const handlers: { prefix: string; fn: FrameHandler }[] = [];
const resyncs = new Set<() => void>();

/**
 * registerHandler calls `fn` for every frame whose name starts with `prefix` ("" for all), after the shared data cache
 * has taken the frame in, so a handler reads the new state. It returns the undo.
 */
export function registerHandler(prefix: string, fn: FrameHandler): () => void {
  const entry = { prefix, fn };
  handlers.push(entry);
  return () => {
    const at = handlers.indexOf(entry);
    if (at >= 0) handlers.splice(at, 1);
  };
}

/** registerResync calls `fn` after a gap in the stream (it reconnected, the app came back), so a feature can catch up. */
export function registerResync(fn: () => void): () => void {
  resyncs.add(fn);
  return () => resyncs.delete(fn);
}

/** dispatch hands one frame to every matching handler, in registration order; one failing handler does not stop the rest. */
export function dispatch(frame: Frame): void {
  for (const { prefix, fn } of [...handlers]) {
    if (!frame.name.startsWith(prefix)) continue;
    try {
      fn(frame);
    } catch (err) {
      console.error(err);
    }
  }
}

/** dispatchResync runs every resync listener. */
export function dispatchResync(): void {
  for (const fn of [...resyncs]) fn();
}
