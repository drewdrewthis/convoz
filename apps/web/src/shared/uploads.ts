// Resumable uploads (design §12.3): create, then PATCH chunks at the server's offset. A dropped connection keeps the bytes that
// arrived, so after any failure the client asks the server where it stands (HEAD) before the next chunk. Used by the composer
// (chosen and dropped files) and by the voice recorder (a note that uploads while it is recorded).
import type { CreateUpload, Upload, UploadState } from "@convoz/api-client";
import { ApiError, call, client } from "./api.ts";

const SLOW_CHUNK = 256 * 1024;
const CHUNK = 1024 * 1024;
/** Tries in a row without progress before an upload fails. */
const TRIES = 5;
/** PATCHes in flight from this page at once: the server takes 4 per identity, one is left for the other tabs. */
const IN_FLIGHT = 3;

/** The headers of the chunk that ends a file whose length was not known at the start. */
export interface LastHeaders {
  "Upload-Length"?: number;
  "Upload-Checksum"?: string;
  "Upload-Duration-Ms"?: number;
  "Upload-Waveform"?: string;
}

/** Where the server stands. `stale` after a failure: the next step asks it again. */
interface Cursor {
  offset: number;
  stale: boolean;
}

interface PumpOptions {
  signal: AbortSignal;
  /** Set when the chunk that reaches the end finishes the file (empty for a file whose size the server knows). */
  last?: LastHeaders;
  onProgress?(sent: number): void;
}

function chunkSize(): number {
  const link = (navigator as Navigator & { connection?: { saveData?: boolean; effectiveType?: string } }).connection;
  return link && (link.saveData || /^(slow-2g|2g|3g)$/.test(link.effectiveType ?? "")) ? SLOW_CHUNK : CHUNK;
}

let busy = 0;
const waiting: (() => void)[] = [];
async function slot<T>(job: () => Promise<T>): Promise<T> {
  while (busy >= IN_FLIGHT) await new Promise<void>((go) => waiting.push(go));
  busy++;
  try {
    return await job();
  } finally {
    busy--;
    waiting.shift()?.();
  }
}

// A network error, a lost race on the offset, a busy or failing server: worth another try. A refusal is not.
const retryable = (err: unknown) =>
  !(err instanceof ApiError) || err.status === 408 || err.status === 409 || err.status === 429 || err.status >= 500 || err.code === "chunk_incomplete";

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((done, fail) => {
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", () => (clearTimeout(timer), fail(signal.reason)), { once: true });
  });

async function sha256(blob: Blob): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", await blob.arrayBuffer()));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** createUpload starts an upload in a conversation (POST /api/uploads). */
export const createUpload = (body: CreateUpload, signal?: AbortSignal): Promise<UploadState> => call(client.POST("/api/uploads", { body, signal }));

async function where(id: string, signal: AbortSignal): Promise<{ offset: number; complete: boolean }> {
  const answer = client.HEAD("/api/uploads/{id}", { params: { path: { id } }, signal });
  await call(answer);
  const { response } = await answer;
  return { offset: Number(response.headers.get("Upload-Offset") ?? 0), complete: response.headers.get("Upload-State") === "complete" };
}

async function patch(id: string, offset: number, bytes: Blob, last: LastHeaders | undefined, signal: AbortSignal) {
  const answer = client.PATCH("/api/uploads/{id}", {
    params: { path: { id }, header: { "Upload-Offset": offset, ...last } },
    headers: { "Content-Type": "application/offset+octet-stream" },
    body: bytes as unknown as string, // sent as the raw bytes, not JSON
    bodySerializer: (raw) => raw,
    signal,
  });
  const state = await call(answer);
  const { response } = await answer;
  return { state, offset: Number(response.headers.get("Upload-Offset") ?? state.offset) };
}

/**
 * pump sends blob from the server's offset up to `end`, one chunk at a time. With `last`, the chunk that reaches `end` ends the
 * file and pump resolves with the finished upload; without, it resolves with null once the server holds `end` bytes.
 */
async function pump(made: UploadState, blob: Blob, at: Cursor, end: number, o: PumpOptions): Promise<UploadState | null> {
  for (let tries = 0; ; ) {
    try {
      if (at.stale) {
        const now = await where(made.id, o.signal);
        at.offset = now.offset;
        at.stale = false;
        o.onProgress?.(at.offset);
        // the answer to the last chunk was lost on the way back; the facts come with the message later
        if (now.complete) return { ...made, state: "complete", offset: now.offset, size: now.offset };
      }
      if (!o.last && at.offset >= end) return null;
      const stop = Math.min(end, at.offset + chunkSize());
      const r = await slot(() => patch(made.id, at.offset, blob.slice(at.offset, stop), o.last && stop === end ? o.last : undefined, o.signal));
      at.offset = r.offset;
      tries = 0;
      o.onProgress?.(at.offset);
      if (r.state.state === "complete") return r.state;
    } catch (err) {
      if (o.signal.aborted || !retryable(err) || ++tries >= TRIES) throw err;
      at.stale = true;
      await sleep(Math.min(16_000, 1000 * 2 ** (tries - 1)) * (0.5 + Math.random() / 2), o.signal);
    }
  }
}

/** audioMs reads how long an audio file plays from its metadata; 0 when the browser cannot tell. */
function audioMs(file: File): Promise<number> {
  return new Promise((done) => {
    const url = URL.createObjectURL(file);
    const probe = new Audio();
    const end = (ms: number) => (URL.revokeObjectURL(url), done(ms));
    probe.preload = "metadata";
    probe.onloadedmetadata = () => end(Number.isFinite(probe.duration) ? Math.round(probe.duration * 1000) : 0);
    probe.onerror = () => end(0);
    probe.src = url;
  });
}

/** uploadFile sends a chosen or dropped file and resolves with the finished upload. `onProgress` gets the bytes the server holds. An audio file goes as a voice note, with its length. */
export async function uploadFile(conversationId: number, file: File, o: { signal: AbortSignal; onProgress?(sent: number): void }): Promise<UploadState> {
  const kind = file.type.startsWith("image/") ? "image" : file.type.startsWith("audio/") ? "audio" : "file";
  const [sum, ms] = await Promise.all([sha256(file), kind === "audio" ? audioMs(file) : Promise.resolve(0)]);
  const made = await createUpload({ conversation_id: conversationId, kind, filename: file.name.slice(0, 255) || "file", size: file.size, sha256: sum }, o.signal);
  const last: LastHeaders = ms > 0 ? { "Upload-Duration-Ms": ms } : {};
  return (await pump(made, file, { offset: made.offset, stale: false }, file.size, { ...o, last }))!;
}

/** An upload whose length is not known while it is made (a voice note being recorded). */
export interface StreamUpload {
  /** Add the next piece. It goes out at once, all but its last byte: the chunk that ends the file must carry bytes. */
  push(piece: Blob): void;
  /** Send the rest with Upload-Length, Upload-Checksum and `extra`; resolves with the finished upload. After a failure it can be
   *  called again: every piece is kept until then. */
  finish(extra: LastHeaders): Promise<UploadState>;
  /** Stop sending. The server forgets an unfinished upload after 24 hours. */
  abort(): void;
}

/** streamUpload creates the upload with the first piece (no size, no checksum) and sends the pieces strictly one after another. */
export function streamUpload(req: CreateUpload): StreamUpload {
  const ctl = new AbortController();
  const parts: Blob[] = [];
  const at: Cursor = { offset: 0, stale: false };
  let made: UploadState | null = null;
  let line: Promise<unknown> = Promise.resolve();
  const ensure = async () => (made ??= await createUpload(req, ctl.signal));
  const run = <T,>(job: () => Promise<T>): Promise<T> => {
    const next = line.then(job);
    line = next.catch(() => {
      at.stale = true;
    });
    return next;
  };
  return {
    push(piece) {
      parts.push(piece);
      run(async () => {
        const whole = new Blob(parts);
        await pump(await ensure(), whole, at, whole.size - 1, { signal: ctl.signal });
      }).catch(() => {}); // the next piece, or finish, tries again
    },
    finish(extra) {
      return run(async () => {
        const whole = new Blob(parts);
        const last = { ...extra, "Upload-Length": whole.size, "Upload-Checksum": `sha256 ${await sha256(whole)}` };
        return (await pump(await ensure(), whole, at, whole.size, { signal: ctl.signal, last }))!;
      });
    },
    abort: () => ctl.abort(),
  };
}

/** asUpload is the file as a message carries it, made from the finished upload so a sent message shows it at once. */
export const asUpload = (s: UploadState, more?: Partial<Upload>): Upload => ({
  id: s.id,
  kind: s.kind,
  name: s.name,
  size: s.size ?? s.offset,
  mime: s.mime ?? "",
  inline: Boolean(s.inline),
  width: s.width,
  height: s.height,
  duration_ms: s.duration_ms,
  ...more,
});

/** fileUrl is where a file of a message is read (same origin, cookie auth). */
export const fileUrl = (id: string): string => `/api/files/${id}`;

/** fileSize writes a size the prototype's way: "4 B", "58 KB". */
export const fileSize = (n: number): string => (n < 1024 ? `${n} B` : `${Math.max(1, Math.round(n / 1024))} KB`);
