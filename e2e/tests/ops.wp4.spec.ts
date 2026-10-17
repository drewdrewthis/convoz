import fs from "node:fs";
import path from "node:path";
import { agentEdits, agentPostWith, byBody, idsByHandle, leaseOf, msgWorld, ownerPurges, pageOf, rowsWith } from "../lib/messages-wp4.ts";
import { searchAs } from "../lib/search-wp12.ts";
import { must } from "../lib/owner.ts";
import { expect, scenario } from "../lib/scenario.ts";

/** Every needle the file holds, as a count (the data file, then the WAL when one is left). */
function bytesWith(dataDir: string, needle: string): number {
  let n = 0;
  for (const f of ["convoz.db", "convoz.db-wal"]) {
    const file = path.join(dataDir, f);
    if (fs.existsSync(file)) n += fs.readFileSync(file).toString("latin1").split(needle).length - 1;
  }
  return n;
}

scenario("Purging a message scrubs every copy of its content", { tag: ["@browser", "@api"] }, async ({ server, dataDir }) => {
  // Given "devtool" posted "ZQX-purge-me" and edited it to "ZQX-purge-edit"
  // (the ask and its answer belong to the asks module, and search to the search module: neither exists in this build, so
  // this scenario covers the copies the message module owns: body, edit history, app, app result and mentions)
  const w = await msgWorld({ server, dataDir, participants: ["devtool", "docs"] });
  const lease = await leaseOf(w, "devtool");
  const first = must(await agentPostWith(w.srv, lease, w.conv, { body: "ZQX-purge-me @docs" }), "post", 201).json().id as number;
  expect((await agentEdits(w.srv, lease, first, { body: "ZQX-purge-edit @docs" })).status).toBe(200);

  // And "devtool" posted an app holding "ZQX-purge-app" that the owner answered through with "ZQX-purge-result"
  const app = { v: 1, type: "code", title: "ZQX-purge-app", fallback: "ZQX-purge-app", props: { mode: "code", text: "ZQX-purge-app" } };
  const appId = must(await agentPostWith(w.srv, lease, w.conv, { body: "ZQX-purge-app", app }), "post an app", 201).json().id as number;
  const db = w.db();
  const ids = idsByHandle(db);
  const viaId = Number(
    db
      .prepare(
        "INSERT INTO messages (conversation_id, author_id, kind, format, body, via_app_agent_id, via_app_message_id, app_result_json, created_at) VALUES (?, ?, 'text', 'plain', 'ZQX-purge-result', ?, ?, '{\"v\":1,\"text\":\"ZQX-purge-result\"}', ?)",
      )
      .run(w.conv, ids.drew!, ids.devtool!, appId, Date.now()).lastInsertRowid,
  );
  expect(rowsWith(db, "ZQX-purge").length).toBeGreaterThan(3);
  db.close();
  expect((await searchAs(w, "ZQX-purge")).results.length, "search finds the posts until they are purged").toBeGreaterThan(0);

  // When the owner purges those messages with a passkey
  for (const id of [first, appId, viaId]) expect((await ownerPurges(w.owner, id)).status, `purge ${id}`).toBe(200);

  // Then the messages show as deleted with no body
  const page = await pageOf(w.owner, w.conv, "limit=100");
  for (const id of [first, appId, viaId]) {
    const m = page.find((x) => x.id === id)!;
    expect([m.deleted, m.purged, m.body]).toEqual([true, true, ""]);
  }
  await expect.poll(() => byBody(w.owner, w.conv, "ZQX-purge-me").then(() => true, () => false)).toBe(false);

  // And search for "ZQX-purge" returns nothing
  expect((await searchAs(w, "ZQX-purge")).results).toEqual([]);
  const index = w.db();
  expect((index.prepare("SELECT COUNT(*) AS n FROM messages_fts_docsize WHERE id IN (?, ?, ?)").get(first, appId, viaId) as { n: number }).n).toBe(0);
  index.close();

  // And every table holds the string 0 times
  const after = w.db();
  expect(rowsWith(after, "ZQX-purge")).toEqual([]);
  after.close();

  // And a byte scan of the data file and the WAL finds every "ZQX-purge" string 0 times
  // (the server stops cleanly first so its WAL is folded into the data file: there is no nightly maintenance yet to do it)
  await w.srv.stop();
  expect(bytesWith(dataDir, "ZQX-purge")).toBe(0);
});
