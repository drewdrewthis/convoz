import fs from "node:fs";
import path from "node:path";
import { expect, scenario } from "../lib/scenario.ts";
import { signInBrowser } from "../lib/machines.ts";
import { snapshot, SEEDED, backupKeys, nightlyBackup, otherKek, readZip, restore, sameOwner, scratch, seededWorld } from "../lib/wp16.ts";

/*
 * WP16's part of ops.feature: signed backups, restore, KEK rotation, destroy and export. The commands and routes are listed at the top
 * of lib/wp16.ts. The privacy screen scenario ("The privacy screen states what cannot be recalled") stays @unimplemented: its screen
 * is Settings -> Privacy & security, which the settings work package (WP13) builds.
 */

scenario("A signed backup restores with the key and the age identity", { tag: ["@cli"] }, async ({ server, convoz, dataDir, kekFile }) => {
  // Given a nightly backup of a data dir with seeded conversations
  const w = await seededWorld(server);
  const keys = await backupKeys(convoz);
  const backup = await nightlyBackup(convoz, dataDir, kekFile, keys);
  const before = await snapshot(w.owner);
  expect(before).toEqual(SEEDED);

  // When it is restored into a new `mktemp -d` dir with the KEK and the age identity
  const into = path.join(scratch(), "data");
  const res = await restore(convoz, backup, into, { kek: kekFile, identity: keys.identity, verifyKey: keys.verifyKey });
  expect(res.code, res.stderr).toBe(0);

  // Then the restored server shows the same conversations, messages and files
  const restored = await server({ dataDir: into, host: "localhost", adminSocket: true });
  expect(await snapshot(sameOwner(w.owner, restored))).toEqual(before);
});

scenario("A restore fails clearly when something is wrong", { tag: ["@cli"] }, async ({ server, convoz, dataDir, kekFile }) => {
  // Given a nightly backup of a data dir with seeded conversations
  await seededWorld(server);
  const keys = await backupKeys(convoz);
  const backup = await nightlyBackup(convoz, dataDir, kekFile, keys);
  const changed = path.join(scratch(), "changed.convoz-backup");
  const bytes = fs.readFileSync(backup);
  bytes[bytes.length >> 1] ^= 0xff;
  fs.writeFileSync(changed, bytes);
  const rows = [
    { fault: "one byte of it changed", file: changed, kek: kekFile, identity: keys.identity, message: "signature does not verify" },
    { fault: "the wrong KEK", file: backup, kek: otherKek(), identity: keys.identity, message: "cannot unwrap the keyring" },
    { fault: "the wrong age identity", file: backup, kek: kekFile, identity: (await backupKeys(convoz)).identity, message: "cannot decrypt the backup" },
  ];
  for (const row of rows) {
    // When it is restored with <fault>
    const scratchDir = scratch();
    const into = path.join(scratchDir, "data");
    const res = await restore(convoz, row.file, into, { kek: row.kek, identity: row.identity, verifyKey: keys.verifyKey });

    // Then the restore stops with the message "<message>" and writes no data dir
    expect(res.code, row.fault).not.toBe(0);
    expect(res.stderr, row.fault).toContain(row.message);
    expect(fs.readdirSync(scratchDir), row.fault).toEqual([]);
  }
});

scenario("A backup made before a KEK rotation still restores", { tag: ["@cli"] }, async ({ server, serveCli, convoz, dataDir, kekFile }) => {
  // Given a backup made with KEK 1
  const w = await seededWorld(server);
  const keys = await backupKeys(convoz);
  const backup = await nightlyBackup(convoz, dataDir, kekFile, keys);
  const before = await snapshot(w.owner);

  // When the owner runs "convoz keys rotate-kek" and later restores that backup
  await w.srv.stop();
  const kek2 = path.join(scratch("convoz-kek2-"), "kek.TESTONLY");
  const rotated = await convoz(["keys", "rotate-kek", "--data-dir", dataDir, "--kek-file", kekFile, "--new-kek-file", kek2]);
  expect(rotated.code, rotated.stderr).toBe(0);
  expect((await serveCli({ kek: kekFile, })).code).toBe(10); // the live data dir now wants KEK 2
  const into = path.join(scratch(), "data");
  const res = await restore(convoz, backup, into, { kek: kekFile, identity: keys.identity, verifyKey: keys.verifyKey });

  // Then the restore works with KEK 1 kept on file
  expect(res.code, res.stderr).toBe(0);
  expect(fs.existsSync(kekFile)).toBe(true);
  const restored = await server({ dataDir: into, kek: kekFile, host: "localhost", adminSocket: true });
  expect(await snapshot(sameOwner(w.owner, restored))).toEqual(before);
});

scenario("Destroying the workspace shreds the keys", { tag: ["@cli"] }, async ({ server, serveCli, convoz, dataDir, kekFile }) => {
  // Given a workspace with seeded conversations
  const w = await seededWorld(server);
  await w.srv.stop();
  const keyring = path.join(dataDir, "keyring.json");
  expect(fs.existsSync(keyring)).toBe(true);

  // When the owner runs "convoz workspace destroy" with the KEK
  const res = await convoz(["workspace", "destroy", "--data-dir", dataDir, "--kek-file", kekFile, "--yes"]);
  expect(res.code, res.stderr).toBe(0);

  // Then the KEK and the keyring are gone
  expect(fs.existsSync(kekFile)).toBe(false);
  expect(fs.existsSync(keyring)).toBe(false);

  // And "convoz serve" on that data dir exits non-zero because the data cannot be opened
  expect((await serveCli({ kek: kekFile })).code).not.toBe(0);
  const fresh = await serveCli({ kek: otherKek() });
  expect(fresh.code).toBe(10);
  expect(fresh.stderr).toContain("is missing");
});

scenario("The owner exports the workspace with a passkey", { tag: ["@browser"] }, async ({ server, page, context, guard }) => {
  // Given the owner has conversations and is signed in
  const w = await seededWorld(server);
  expect((await w.owner.client.post("/api/me/export")).status).toBe(403); // no passkey check, no export
  await signInBrowser(w.srv, w.owner, page, context);
  await page.goto(`${w.srv.origin}/settings/export`);
  const before = guard.ceremonies().length;

  // When the owner starts an export with a passkey
  await page.getByRole("button", { name: "Export my data" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Export", exact: true }).click();

  // Then a download is offered when the job is done
  const link = page.getByRole("link", { name: "Download export" });
  await expect(link).toBeVisible();
  expect(guard.ceremonies().slice(before).map((c) => c.kind)).toEqual(["get"]);
  const [download] = await Promise.all([page.waitForEvent("download"), link.click()]);
  const zip = readZip(fs.readFileSync(await download.path()));

  // And the export holds every conversation and file the owner can see
  const manifest = JSON.parse(zip.get("manifest.json")!.toString("utf8"));
  expect(manifest.conversations).toBe(Object.keys(SEEDED).length);
  for (const [title, bodies] of Object.entries(SEEDED)) {
    const conv = JSON.parse(zip.get(`conversations/${w.ids[title]}.json`)!.toString("utf8"));
    expect(conv.title).toBe(title);
    expect(conv.messages.map((m: { body: string }) => m.body)).toEqual(bodies);
  }
});
