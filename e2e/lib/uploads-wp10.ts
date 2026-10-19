import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import type { ServerHandle } from "./fixtures.ts";
import type { Owner } from "./owner.ts";
import { must } from "./owner.ts";
import { clientId } from "./machines.ts";
import { record } from "./transcript.ts";

/**
 * UPLOADS, FILES AND VOICE (WP10): the contract the bindings in tests/uploads.wp10.spec.ts, voice.wp10.spec.ts and composer.wp10.spec.ts
 * assert (packages/contracts/paths/upload.yaml has the full text):
 *
 *   POST  /api/uploads {conversation_id, kind, filename, size?, sha256?}  -> 201 {id, state, offset, ...}   (no size: length not known yet)
 *   PATCH /api/uploads/:id  Upload-Offset, body bytes  -> 200 {state, offset, mime?, inline?}; 409 offset_mismatch; 413 upload_too_large / image_too_large
 *   HEAD  /api/uploads/:id  -> Upload-Offset, Upload-State
 *   GET   /api/files/:id    -> bytes; Content-Disposition inline|attachment, nosniff, CSP "sandbox; default-src 'none'"
 *   POST  /api/conversations/:id/messages {upload_ids} -> 409 when bound already or unfinished, 400 for another conversation
 *   PATCH /api/me/profile {avatar_svg}; GET /api/identities/:id/avatar.svg
 *   PATCH /api/settings {scope:"workspace", key:"transcription.engine", value:"fake"}; POST /__test/transcriber {text, fail}
 */

/** Who calls: the signed-in owner (cookie), or an agent with a lease. */
export type Actor = { srv: ServerHandle; owner: Owner } | { srv: ServerHandle; lease: string };

export interface Raw {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
  text: string;
  json<T = any>(): T;
}

/** One request with a binary body, as the owner's browser or an agent's CLI would send it. */
export function raw(who: Actor, method: string, urlPath: string, o: { json?: unknown; headers?: Record<string, string>; body?: Buffer } = {}): Promise<Raw> {
  const t = who.srv.target;
  const headers: Record<string, string> = { Host: `${t.host}:${t.tcpPort}` };
  if ("lease" in who) headers.Authorization = `Bearer ${who.lease}`;
  else {
    headers.Cookie = who.owner.client.cookieHeader();
    headers.Origin = t.origin;
    headers["X-Convoz"] = "1";
  }
  let body = o.body;
  if (o.json !== undefined) {
    body = Buffer.from(JSON.stringify(o.json));
    headers["Content-Type"] = "application/json";
  } else if (method === "PATCH" && body) headers["Content-Type"] = "application/offset+octet-stream";
  if (body) headers["Content-Length"] = String(body.length);
  Object.assign(headers, o.headers ?? {});
  return new Promise((resolve, reject) => {
    const req = http.request({ method, path: urlPath, headers, host: "127.0.0.1", port: t.tcpPort, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        const buf = Buffer.concat(chunks);
        const text = buf.toString("utf8");
        record(`HTTP ${method} ${urlPath}`, buf.length > 2000 ? `[${buf.length} bytes]` : text, "", `status=${res.statusCode}`);
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: buf, text, json: <T>() => JSON.parse(text) as T });
      });
      res.on("error", reject);
    });
    req.setTimeout(60_000, () => req.destroy(new Error(`${method} ${urlPath}: no answer`)));
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

export const sha256 = (b: Buffer): string => crypto.createHash("sha256").update(b).digest("hex");

export interface UploadState {
  id: string;
  state: "receiving" | "complete";
  offset: number;
  size?: number;
  kind: string;
  name: string;
  mime?: string;
  inline?: boolean;
}

/** `POST /api/uploads` for a file of known size. */
export function startUpload(who: Actor, conv: number, kind: string, filename: string, bytes: Buffer, size = bytes.length): Promise<Raw> {
  return raw(who, "POST", "/api/uploads", { json: { conversation_id: conv, kind, filename, size, sha256: sha256(bytes) } });
}

/** One chunk at an offset. */
export function sendChunk(who: Actor, id: string, offset: number, bytes: Buffer, extra: Record<string, string> = {}): Promise<Raw> {
  return raw(who, "PATCH", `/api/uploads/${id}`, { body: bytes, headers: { "Upload-Offset": String(offset), ...extra } });
}

export const headUpload = (who: Actor, id: string): Promise<Raw> => raw(who, "HEAD", `/api/uploads/${id}`);

/** Create an upload and send all its bytes in chunks; returns the finished state. */
export async function uploadWhole(who: Actor, conv: number, kind: string, filename: string, bytes: Buffer, chunk = 600_000, extra: Record<string, string> = {}): Promise<UploadState> {
  const made = must(await startUpload(who, conv, kind, filename, bytes), `start ${filename}`, 201).json<UploadState>();
  let last = made;
  for (let at = 0; at < bytes.length; at += chunk) {
    last = must(await sendChunk(who, made.id, at, bytes.subarray(at, at + chunk), extra), `chunk of ${filename} at ${at}`).json<UploadState>();
  }
  return last;
}

/** Post a message that carries uploads (the owner or an agent). */
export function postWith(who: Actor, conv: number, body: string, uploadIds: string[]): Promise<Raw> {
  return raw(who, "POST", `/api/conversations/${conv}/messages`, { json: { client_id: clientId(), body, needs_you: false, upload_ids: uploadIds } });
}

export const getFile = (who: Actor, id: string, headers: Record<string, string> = {}): Promise<Raw> => raw(who, "GET", `/api/files/${id}`, { headers });

/** Set the workspace transcription engine ("none" or "fake") and what the fake engine answers. */
export async function setEngine(who: { srv: ServerHandle; owner: Owner }, engine: string, text = "fake transcript", delayMs = 0): Promise<void> {
  must(await who.owner.client.request("PATCH", "/api/settings", { csrf: true, json: { scope: "workspace", key: "transcription.engine", value: engine } }), "set engine");
  must(await who.owner.client.request("POST", "/__test/transcriber", { csrf: true, json: { text, fail: false, delay_ms: delayMs } }), "set fake text");
}

// ---- fixtures ------------------------------------------------------------------------------------------

const crcTable = (): ((b: Buffer) => number) => (b) => zlib.crc32(b);

function pngChunk(kind: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(kind, 4, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crcTable()(Buffer.concat([Buffer.from(kind), data])), 0);
  return Buffer.concat([head, data, crc]);
}

/** A PNG whose header says w by h. With `pixels` the image data is real (small sizes only); without, it holds one empty row: all a size check reads. */
export function png(w: number, h: number, pixels = false): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  const rows = pixels ? Buffer.concat(Array.from({ length: h }, (_, y) => Buffer.concat([Buffer.from([0]), Buffer.alloc(w * 3, 40 + (y % 200))]))) : Buffer.from([0]);
  return Buffer.concat([Buffer.from("\x89PNG\r\n\x1a\n", "latin1"), pngChunk("IHDR", ihdr), pngChunk("IDAT", zlib.deflateSync(rows)), pngChunk("IEND", Buffer.alloc(0))]);
}

/** A mono 16-bit WAV: a tone of `seconds`, at `rate` Hz. */
export function wav(seconds: number, rate = 16000, hz = 440): Buffer {
  const n = Math.round(seconds * rate);
  const data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * hz * i) / rate) * 9000 * (0.5 + 0.5 * Math.sin(i / 4000))), i * 2);
  const head = Buffer.alloc(44);
  head.write("RIFF", 0);
  head.writeUInt32LE(36 + data.length, 4);
  head.write("WAVEfmt ", 8);
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20);
  head.writeUInt16LE(1, 22);
  head.writeUInt32LE(rate, 24);
  head.writeUInt32LE(rate * 2, 28);
  head.writeUInt16LE(2, 32);
  head.writeUInt16LE(16, 34);
  head.write("data", 36);
  head.writeUInt32LE(data.length, 40);
  return Buffer.concat([head, data]);
}

/** An Ogg-looking audio file of `size` bytes whose body is a 64-byte `marker` repeated. */
export function ogg(size: number, marker = Buffer.alloc(64, "ZQXAUDIOFIXTURE0")): Buffer {
  const out = Buffer.alloc(size);
  out.write("OggS\0");
  for (let at = 16; at + marker.length <= size; at += marker.length) marker.copy(out, at);
  return out;
}

export const html = (): Buffer => Buffer.from("<html><body><script>alert(1)</script></body></html>");
export const svgFile = (): Buffer => Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>');

/** A scratch dir of this run for fixture files a browser must read from disk. */
export const scratch = (prefix = "convoz-wp10-"): string => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

/** The VmHWM (peak resident memory, kB) of a process, from /proc. */
export function peakRssKb(pid: number): number {
  const m = /VmHWM:\s+(\d+) kB/.exec(fs.readFileSync(`/proc/${pid}/status`, "utf8"));
  return m ? Number(m[1]) : 0;
}

/** Every file under a directory, as {file, bytes}. */
export function filesUnder(dir: string): { file: string; bytes: Buffer }[] {
  const out: { file: string; bytes: Buffer }[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...filesUnder(p));
    else if (e.isFile()) out.push({ file: p, bytes: fs.readFileSync(p) });
  }
  return out;
}
