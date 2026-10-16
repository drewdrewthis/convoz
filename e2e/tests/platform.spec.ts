import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, goBin, repoRoot, run, baseEnv, scenario, serveDefaults } from "../lib/scenario.ts";

const SEED = { "seed-1": "TESTONLY one", "seed-2": "TESTONLY two", "seed-3": "TESTONLY three" };

scenario("The server refuses a database from a newer version", { tag: ["@cli"] }, async ({ dataDir, kekFile, server, testApi, convoz }) => {
  // Given a data dir migrated by a newer build
  const first = await server();
  await testApi(first).setSchemaVersion(999);
  await first.stop();

  // When this build runs "convoz serve"
  const res = await convoz(["serve", "--data-dir", dataDir, "--kek-file", kekFile, "--listen", "127.0.0.1:0", ...serveDefaults()]);

  // Then it exits non-zero with a message naming both versions (exit 11)
  expect(res.code).toBe(11);
  expect(res.stderr).toMatch(/convoz: data dir schema version 999 is newer than this build supports \(\d+\)/);

  // And a relative --data-dir reaches the same answer (it is made absolute before the database opens).
  // The binary runs from repoRoot, so the path is relative to repoRoot.
  const rel = await convoz(["serve", "--data-dir", path.relative(repoRoot, dataDir), "--kek-file", kekFile, "--listen", "127.0.0.1:0", ...serveDefaults()]);
  expect(rel.code).toBe(11);
});

scenario("A migration starts with a backup", { tag: ["@cli"] }, async ({ dataDir, server, testApi, convoz }) => {
  // Given a data dir from the previous release (migrations stop at 1) with seeded data
  const old = await server({ env: { CONVOZ_TEST_MAX_MIGRATION: "1" } });
  for (const [k, v] of Object.entries(SEED)) await testApi(old).setKv(k, v);
  await old.stop();

  // When this build starts and migrates it
  const before = Date.now();
  const cur = await server();
  const after = Date.now();

  // Then an encrypted backup file dated before the migration exists
  const backups = path.join(dataDir, "backups");
  const names = fs.readdirSync(backups).filter((n) => /^pre-migrate-v1-\d+\.db$/.test(n));
  expect(names).toHaveLength(1);
  const stamp = Number(names[0]!.match(/-(\d+)\.db$/)![1]);
  expect(stamp).toBeGreaterThanOrEqual(before);
  expect(stamp).toBeLessThanOrEqual(after);

  // A plain (non-adiantum) open of the backup fails: it is encrypted
  const plainOpen = () => {
    const db = new DatabaseSync(path.join(backups, names[0]!), { readOnly: true });
    try {
      db.prepare("SELECT count(*) FROM sqlite_master").get();
    } finally {
      db.close();
    }
  };
  expect(plainOpen).toThrow(/file is not a database/);

  // And the seeded data is intact, and the schema is the newest this build knows (from "convoz version")
  for (const [k, v] of Object.entries(SEED)) expect(await testApi(cur).getKv(k)).toBe(v);
  const ver = await convoz(["version"]);
  const latest = Number(ver.stdout.match(/\(schema (\d+)\)/)?.[1]);
  expect(latest).toBeGreaterThan(1);
  expect(await testApi(cur).getSchemaVersion()).toBe(latest);
  await cur.stop();

  // The backup restores: its file and keyring copy, in a fresh data dir, start at the old schema with the seed rows
  const restored = fs.mkdtempSync(path.join(os.tmpdir(), "convoz-restore-"));
  fs.copyFileSync(path.join(backups, names[0]!), path.join(restored, "convoz.db"));
  fs.copyFileSync(path.join(backups, names[0]!.replace(/\.db$/, ".keyring.json")), path.join(restored, "keyring.json"));
  const back = await server({ dataDir: restored, env: { CONVOZ_TEST_MAX_MIGRATION: "1" } });
  expect(await testApi(back).getSchemaVersion()).toBe(1);
  for (const [k, v] of Object.entries(SEED)) expect(await testApi(back).getKv(k)).toBe(v);
});

scenario("The storage engine meets the search budget on 1M rows", { tag: ["@cli", "@bench"] }, async ({}, info) => {
  info.setTimeout(25 * 60_000);
  // Given an encrypted data dir with a synthetic 1M-row full-text table (the benchmark builds it in CONVOZ_BENCH_DATA_DIR)
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "convoz-bench-"));
  // When the storage benchmark runs
  const res = await run(goBin, ["test", "-timeout", "20m", "-run", "x", "-bench", "BenchmarkFTS1M", "./..."], {
    cwd: path.join(repoRoot, "apps", "convoz"),
    env: baseEnv({
      GOFLAGS: "-mod=readonly",
      CONVOZ_BENCH_DATA_DIR: scratch,
      GOCACHE: process.env.GOCACHE ?? path.join(os.homedir(), ".cache", "go-build"),
      GOPATH: process.env.GOPATH ?? path.join(os.homedir(), "go"),
    }),
    timeoutMs: 24 * 60_000,
  });
  expect(res.code, res.stdout + res.stderr).toBe(0);

  // Then inserts have p95 at most 10 ms and searches p95 at most 50 ms
  const insert = res.stdout.match(/([\d.]+)\s+insert-p95-ms/);
  const search = res.stdout.match(/([\d.]+)\s+search-p95-ms/);
  expect(insert, "no insert-p95-ms line in benchmark output").not.toBeNull();
  expect(search, "no search-p95-ms line in benchmark output").not.toBeNull();
  expect(Number(insert![1])).toBeLessThanOrEqual(10);
  expect(Number(search![1])).toBeLessThanOrEqual(50);
});
