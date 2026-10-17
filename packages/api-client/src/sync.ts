// The sync engine: one live stream for the whole app, feeding the shared data cache and then every feature handler
// (handlers.ts). Today it is the SSE stream plus a per-conversation catch-up after a gap; the cursor delta
// (GET /api/sync), the long-poll fallback and the outbox drain join here later behind the same surface.
import type { DataCache } from "./cache.ts";
import { LIMIT, maxId } from "./cache.ts";
import { coalesce } from "./coalesce.ts";
import { dispatch, dispatchResync } from "./handlers.ts";
import type { DataSource } from "./source.ts";
import { openStream, type Stream } from "./stream.ts";
import { FRAME_NAMES, type Frame } from "./types.ts";

export interface Sync {
  /** Hold the stream open; the returned function lets go. The stream closes when nobody holds it. */
  hold(): () => void;
  /** Reopen a stream the phone closed without telling us. */
  ensure(): void;
  /** Fetch the messages after the newest one held for a conversation, and hand each to the cache and the handlers. */
  catchUp(conversationId: number): Promise<void>;
}

/** createSync wires the stream to the cache and the handlers. */
export function createSync(cache: DataCache, source: DataSource, open: typeof openStream = openStream): Sync {
  let stream: Stream | null = null;
  let holders = 0;
  const jobs = new Map<number, () => Promise<void>>();

  const ingest = (frame: Frame) => {
    if (cache.apply(frame)) dispatch(frame);
  };
  const catchUp = (id: number) => {
    let job = jobs.get(id);
    if (!job) {
      job = coalesce(async () => {
        for (;;) {
          const held = cache.store.getState().messages[id];
          if (!held) return; // the page has not loaded its newest page yet; that load brings everything
          const after = maxId(held);
          const { messages } = await source.messages(id, { after: after || undefined, limit: LIMIT });
          for (const m of messages) ingest({ name: "message.created", data: { ...m, conversation_id: id, author_handle: m.author.handle } });
          if (messages.length < LIMIT) break;
        }
        if (!cache.store.getState().rows[id]?.title) await cache.loadConversation(id);
      });
      jobs.set(id, job);
    }
    return job();
  };
  const resync = () => {
    cache.resync();
    for (const id of Object.keys(cache.store.getState().messages)) void catchUp(Number(id));
    dispatchResync();
  };

  return {
    hold() {
      holders++;
      stream ??= open(FRAME_NAMES, ingest, resync);
      let held = true;
      return () => {
        if (!held) return;
        held = false;
        if (--holders === 0) {
          stream?.close();
          stream = null;
        }
      };
    },
    ensure: () => stream?.ensure(),
    catchUp,
  };
}
