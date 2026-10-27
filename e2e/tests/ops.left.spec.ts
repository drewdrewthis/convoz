import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { agentSays, createConversation, messagesOf, startSession } from "../lib/chat.ts";
import { chatWorld } from "../lib/chat.ts";
import { countOf, dataFileBytes, signInBrowser } from "../lib/machines.ts";
import { bootstrapOwner } from "../lib/owner.ts";
import { expect, scenario } from "../lib/scenario.ts";
import { backupKeys, nightlyBackup, restore, scratch } from "../lib/wp16.ts";

// Bindings of ops.feature and contracts/ops.feature that the ops work package left open: the privacy screen (it needs the settings
// screen of the settings work package) and the plain-reader check of the data file and a backup snapshot.

scenario("The privacy screen states what cannot be recalled", { tag: ["@browser"] }, async ({ server, page, context }) => {
  // Given the owner is signed in
  const srv = await server({ host: "localhost", adminSocket: true });
  const owner = await bootstrapOwner(srv);
  await signInBrowser(srv, owner, page, context);

  // When the owner opens Settings → Privacy & security → Delete
  await page.goto(`${srv.origin}/settings`);
  await page.getByRole("link", { name: "Privacy & security" }).click();
  await page.getByRole("link", { name: /^Delete my data/ }).click();
  await expect(page.getByRole("heading", { name: "Delete my data", level: 1 })).toBeVisible();

  // Then the screen states the 24 hour index window, the 35 day backup window and that shown notifications cannot be recalled
  const screen = page.getByRole("list", { name: "What stays after a delete" });
  await expect(screen).toContainText(/search index is cleaned within 24 hours/i);
  await expect(screen).toContainText(/backups age out within 35 days/i);
  await expect(screen).toContainText(/notification already shown on a device cannot be recalled/i);
});

/** Whether a plain SQLite reader can open the file: the error text if it cannot, else "opened". */
function plainReaderSays(file: string): string {
  try {
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      db.prepare("SELECT count(*) FROM sqlite_master").get();
      return "opened";
    } finally {
      db.close();
    }
  } catch (err) {
    return (err as Error).message;
  }
}

/** Every regular file under `dir`. */
function filesUnder(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? filesUnder(path.join(dir, e.name)) : [path.join(dir, e.name)]));
}

scenario("The data file cannot be read without the key", { tag: ["@cli"] }, async ({ server, convoz, dataDir, kekFile }) => {
  // Given "devtool" posted the seeded body "ZQX-secret-plan" in conversation 41
  const w = await chatWorld(server, { agents: ["devtool"] });
  const conv = await createConversation(w.owner, { title: "Ship search filters", participants: ["devtool"] });
  const devtool = await startSession(w.box, "devtool", "secret");
  await agentSays(w.srv, devtool.lease, conv, "ZQX-secret-plan");
  await expect.poll(async () => (await messagesOf(w.owner, conv)).map((m) => m.body), { message: "the server itself reads it" }).toContain("ZQX-secret-plan");

  // When the data file and a fresh backup snapshot are opened with a plain SQLite reader
  const keys = await backupKeys(convoz);
  const backup = await nightlyBackup(convoz, dataDir, kekFile, keys);
  const into = path.join(scratch(), "data");
  const restored = await restore(convoz, backup, into, { kek: kekFile, identity: keys.identity, verifyKey: keys.verifyKey });
  expect(restored.code, restored.stderr).toBe(0);
  const snapshot = path.join(into, "convoz.db");
  const live = path.join(dataDir, "convoz.db");

  // Then both answer "file is not a database"
  expect(plainReaderSays(live)).toContain("file is not a database");
  expect(plainReaderSays(snapshot)).toContain("file is not a database");

  // And a strings scan of the data file, the WAL, the snapshot and every blob finds "ZQX-secret-plan" 0 times
  const scanned = [dataFileBytes(dataDir), fs.readFileSync(snapshot), ...filesUnder(path.join(dataDir, "blobs")).map((f) => fs.readFileSync(f))];
  expect(scanned[0]!.length, "the data file has bytes to scan").toBeGreaterThan(4096);
  expect(scanned.map((bytes) => countOf(bytes, "ZQX-secret-plan"))).toEqual(scanned.map(() => 0));
});
