// The sync engine: one live link for the whole app, feeding the shared data cache and then every feature handler (handlers.ts).
//
// The link is the event stream, or the long poll when the stream keeps failing (sync/link.ts). The engine keeps one cursor in
// the event log (`epoch:seq`), moves it with every stored frame, and reads the delta (GET /api/sync) whenever it may have
// missed something: a stream that opened or came back, a frame that names a frame it never saw, a poll that returned. A cursor
// the server no longer knows gets a reset: the engine loads a snapshot and reads its state over the plain routes again.
import type { DataCache } from "./cache.ts";
import { LIMIT, maxId } from "./cache.ts";
import { coalesce } from "./coalesce.ts";
import { dispatch, dispatchResync } from "./handlers.ts";
import type { DataSource } from "./source.ts";
import { formatCursor, parseCursor, type Cursor } from "./sync/cursor.ts";
import { openLink, type Link } from "./sync/link.ts";
import { FRAME_NAMES, type Frame, type SyncAnswer } from "./types.ts";

/** Where the engine keeps its cursor between visits, so a warm start reads only the delta. */
export interface CursorStore {
  load(): Promise<Cursor | null>;
  save(cursor: Cursor): void;
}

export interface SyncOptions {
  cursor?: CursorStore;
  open?: typeof openLink;
}

export interface Sync {
  /** Hold the link open; the returned function lets go. The link closes when nobody holds it. */
  hold(): () => void;
  /** The app came back: reopen a stream the phone closed without telling us, or try the stream again. */
  ensure(): void;
  /** Fetch the messages after the newest one held for a conversation, and hand each to the cache and the handlers. */
  catchUp(conversationId: number): Promise<void>;
}

/** The longest a poll is held by the server (design §12.3). */
const POLL_WAIT_SECONDS = 25;

/** createSync wires the link to the cache and the handlers. */
export function createSync(cache: DataCache, source: DataSource, options: SyncOptions = {}): Sync {
  const open = options.open ?? openLink;
  let link: Link | null = null;
  let holders = 0;
  let cursor: Cursor | null = null;
  const ready = (options.cursor?.load() ?? Promise.resolve(null)).then(
    (held) => void (cursor ??= held),
    () => {}, // no stored cursor: the first link starts from a snapshot
  );
  const jobs = new Map<number, () => Promise<void>>();

  const ingest = (frame: Frame) => {
    if (cache.apply(frame)) dispatch(frame);
  };
  /** Move the cursor forward; a cursor of another epoch replaces it. */
  const advance = (to: Cursor) => {
    if (cursor && cursor.epoch === to.epoch && to.seq <= cursor.seq) return;
    cursor = to;
    options.cursor?.save(to);
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
  /** An ask changes in its message, not as a new message, so a gap in the stream leaves a held card stale: read its conversation's asks again. */
  const refreshAsks = async (id: number) => {
    if (!cache.store.getState().messages[id]?.list.some((m) => m.kind === "ask")) return;
    const { messages } = await source.messages(id, { limit: LIMIT });
    for (const m of messages) if (m.kind === "ask" && m.ask) ingest({ name: "ask.changed", data: m.ask });
  };
  const resync = () => {
    cache.resync();
    for (const id of Object.keys(cache.store.getState().messages)) {
      void catchUp(Number(id));
      void refreshAsks(Number(id)).catch(() => {});
    }
    dispatchResync();
  };

  /** Start over from where the log stands now: whatever was held is read again over the plain routes. */
  const snapshotAndResync = async () => {
    const snap = await source.snapshot();
    const at = parseCursor(snap.cursor);
    if (at) {
      cursor = at;
      options.cursor?.save(at);
    }
    resync();
  };

  /** Take in one answer of GET /api/sync. Returns true when the server has more events waiting. */
  const apply = async (answer: SyncAnswer): Promise<boolean> => {
    if ("reset" in answer) {
      await snapshotAndResync();
      return false;
    }
    const talked = new Set<number>();
    const asked = new Set<number>();
    const planned = new Set<number>();
    let listChanged = false;
    for (const ev of answer.events) {
      if (ev.type === "message.created.v1" && ev.conversation_id) talked.add(ev.conversation_id);
      if (ev.type.startsWith("ask.") && ev.conversation_id) asked.add(ev.conversation_id);
      if (ev.type.startsWith("plan.") && ev.conversation_id) planned.add(ev.conversation_id);
      listChanged = true; // a new message (a reply is not in the main list, but it moves the unread count), a new conversation or a read changes the rail
    }
    await Promise.all([...talked].map(catchUp));
    await Promise.all([...asked].map((id) => refreshAsks(id).catch(() => {})));
    // A plan has no message to read again: its readers (the panel, Now) listen for the frame the stream would have sent.
    for (const id of planned) dispatch({ name: "plan.changed", data: { conversation_id: id } });
    if (listChanged) cache.resync();
    const to = parseCursor(answer.cursor);
    if (to) advance(to);
    return answer.more;
  };

  /** Read the delta from the cursor until nothing more waits. */
  const pull = coalesce(async () => {
    await ready;
    for (;;) {
      if (!cursor) return snapshotAndResync();
      if (!(await apply(await source.delta(formatCursor(cursor))))) return;
    }
  });

  const onFrame = (frame: Frame, at: { cursor: Cursor; prev: number } | null) => {
    if (!at) return ingest(frame); // live only: never stored, never replayed
    if (cursor && cursor.epoch !== at.cursor.epoch) {
      ingest(frame);
      void snapshotAndResync().catch(() => {});
    } else if (cursor && at.cursor.seq <= cursor.seq) {
      return; // a replay of what a delta already brought
    } else if (cursor && at.prev > cursor.seq) {
      ingest(frame);
      void pull(); // a frame before this one never came: the delta from the old cursor has it, and moves the cursor
    } else {
      ingest(frame);
      advance(at.cursor);
    }
  };

  return {
    hold() {
      holders++;
      link ??= open(FRAME_NAMES, {
        onFrame,
        onOpen: () => void pull(),
        onReset: () => void snapshotAndResync().catch(() => {}),
        poll: async (signal) => {
          await ready;
          if (!cursor) return snapshotAndResync();
          await apply(await source.delta(formatCursor(cursor), POLL_WAIT_SECONDS, signal));
        },
      });
      let held = true;
      return () => {
        if (!held) return;
        held = false;
        if (--holders === 0) {
          link?.close();
          link = null;
        }
      };
    },
    ensure: () => link?.ensure(),
    catchUp,
  };
}
