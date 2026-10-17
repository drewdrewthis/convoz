import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { chatWorld, createConversation, listConversations, messagesOf, ownerSays } from "./chat.ts";
import type { ConvozRun, ServerHandle, ServerOptions } from "./fixtures.ts";
import { Client } from "./http.ts";
import type { Owner } from "./owner.ts";

/**
 * Helpers for the WP16 scenarios (ops.feature): backups, restore, key rotation, destroy and export. CLI contract:
 *   convoz backup keygen --dir D                   writes backup-recipient.pub, backup-signing.key, backup-identity.key, backup-verify.pub
 *   convoz backup --data-dir D --kek-file K --recipient F --sign-key F --out FILE
 *   convoz restore --backup FILE --into DIR --kek-file K --identity F --verify-key F   (exit 10 for a key fault; no data dir on any fault)
 *   convoz keys rotate-kek --data-dir D --kek-file OLD --new-kek-file NEW
 *   convoz workspace destroy --data-dir D --kek-file K --yes
 * Export: POST /api/me/export (step-up "data.export") -> 202 {id,status}; GET /api/me/export/:id -> {id,status};
 * GET /api/me/export/:id?download=1 -> zip with manifest.json and conversations/<id>.json. Page: /settings/export.
 */

export const scratch = (prefix = "convoz-wp16-"): string => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

/** A fake KEK like the fixture's, with another fill byte: base64 of 32 bytes starting with TESTONLY, mode 0600. */
export function otherKek(fill = 0x41): string {
  const raw = Buffer.alloc(32, fill);
  raw.write("TESTONLY", 0, "ascii");
  const file = path.join(scratch("convoz-kek2-"), "kek.TESTONLY");
  fs.writeFileSync(file, raw.toString("base64"), { mode: 0o600 });
  return file;
}

export interface Conversations {
  [title: string]: string[];
}

/** Title -> message bodies of every conversation the owner sees. */
export async function snapshot(owner: Owner): Promise<Conversations> {
  const out: Conversations = {};
  for (const c of await listConversations(owner)) out[c.title ?? `#${c.id}`] = (await messagesOf(owner, c.id)).map((m) => m.body);
  return out;
}

export const SEEDED: Conversations = {
  "Ship search filters": ["Filters ship on Friday.", "Which fields first?", "Title and author."],
  "Nightly export": ["The export got slower.", "It skips the warm cache now."],
};

/** Background plus seeded conversations: owner "drew", machine "box-2" with "devtool", two conversations with messages. */
export async function seededWorld(server: (o?: ServerOptions) => Promise<ServerHandle>) {
  const w = await chatWorld(server, { agents: ["devtool"] });
  const ids: Record<string, number> = {};
  for (const [title, bodies] of Object.entries(SEEDED)) {
    ids[title] = await createConversation(w.owner, { title, participants: ["devtool"] });
    for (const body of bodies) await ownerSays(w.owner, ids[title]!, body);
  }
  return { ...w, ids };
}

export interface BackupKeys {
  dir: string;
  recipient: string;
  signKey: string;
  identity: string;
  verifyKey: string;
}

/** `convoz backup keygen` into a new scratch dir. */
export async function backupKeys(convoz: ConvozRun): Promise<BackupKeys> {
  const dir = scratch("convoz-backup-keys-");
  const res = await convoz(["backup", "keygen", "--dir", dir]);
  if (res.code !== 0) throw new Error(`backup keygen failed: ${res.code} ${res.stderr}`);
  const f = (n: string) => path.join(dir, n);
  return { dir, recipient: f("backup-recipient.pub"), signKey: f("backup-signing.key"), identity: f("backup-identity.key"), verifyKey: f("backup-verify.pub") };
}

/** `convoz backup` of a data dir (the server may be running). Returns the backup file. */
export async function nightlyBackup(convoz: ConvozRun, dataDir: string, kekFile: string, keys: BackupKeys): Promise<string> {
  const out = path.join(scratch("convoz-backups-"), "nightly.convoz-backup");
  const res = await convoz(["backup", "--data-dir", dataDir, "--kek-file", kekFile, "--recipient", keys.recipient, "--sign-key", keys.signKey, "--out", out]);
  if (res.code !== 0) throw new Error(`backup failed: ${res.code} ${res.stderr}`);
  return out;
}

export interface RestoreOptions {
  kek: string;
  identity: string;
  verifyKey: string;
}

/** `convoz restore` of a backup into `into`. The raw result. */
export function restore(convoz: ConvozRun, backup: string, into: string, o: RestoreOptions) {
  return convoz(["restore", "--backup", backup, "--into", into, "--kek-file", o.kek, "--identity", o.identity, "--verify-key", o.verifyKey]);
}

/** The same owner on another server over the same data: the device cookie is in the restored database. */
export function sameOwner(owner: Owner, srv: ServerHandle): Owner {
  const client = new Client(srv.target);
  for (const [k, v] of owner.client.jar) client.jar.set(k, v);
  return { ...owner, client };
}

/** The entries of a zip file by name, read from its central directory. */
export function readZip(buf: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (end < 0) throw new Error("not a zip file");
  let at = buf.readUInt32LE(end + 16);
  for (let i = buf.readUInt16LE(end + 10); i > 0; i--) {
    const method = buf.readUInt16LE(at + 10);
    const size = buf.readUInt32LE(at + 20);
    const nameLen = buf.readUInt16LE(at + 28);
    const extraLen = buf.readUInt16LE(at + 30);
    const commentLen = buf.readUInt16LE(at + 32);
    const local = buf.readUInt32LE(at + 42);
    const name = buf.toString("utf8", at + 46, at + 46 + nameLen);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.subarray(start, start + size);
    out.set(name, method === 8 ? zlib.inflateRawSync(data) : data);
    at += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}
