import { composer, message, messageLog, uiWorld } from "../lib/chat-ui.ts";
import { createConversation, inboxItems, messagesOf, openStream, ownerPost, ownerSays, startSession } from "../lib/chat.ts";
import { deltaFrom, platformWorld, seedMessages, snapshotOf, stallProxy, syncRaw } from "../lib/event.ts";
import { send } from "../lib/http.ts";
import { plainDb } from "../lib/machines.ts";
import { must } from "../lib/owner.ts";
import { expect, scenario } from "../lib/scenario.ts";

/*
 * EVENT BACKBONE AND SYNC (WP2), platform contracts. Read with specs/contracts/platform.feature and the contract block atop lib/event.ts.
 * Not bound here, and why:
 *   "Cross-record rules hold ...", "Counters match the messages ...", "Events never carry content" need asks (WP8), uploads (WP10),
 *   app messages (WP11) and threads, deletes and removals (WP3, WP5). "A write and its event, inbox item, search entry and audit row
 *   appear together" is bound below; "Counters match ..." is bound in platform.left.spec.ts; the other two still wait for WP11 and WP10.
 */

scenario("A failed write leaves no event behind", { tag: ["@api"] }, async ({ server }) => {
  // Given the owner's event cursor is at the newest event
  const { w, conv } = await platformWorld(server);
  await ownerSays(w.owner, conv, "first");
  const at = (await snapshotOf(w.owner)).cursor;

  // When the owner posts a message that the server refuses with 400
  const refused = await ownerPost(w.owner, conv, "x".repeat(16_385));
  expect(refused.status).toBe(400);

  // Then GET /api/sync from that cursor returns no new event
  const delta = await deltaFrom(w.owner, at);
  expect(delta.events).toEqual([]);
  expect(delta.cursor).toBe(at);

  // And conversation 41 shows no new message
  await expect.poll(async () => (await messagesOf(w.owner, conv)).map((m) => m.body)).toEqual(["first"]);
});

scenario("Stored events cannot be changed", { tag: ["@api"] }, async ({ server, dataDir }) => {
  // Given the server runs as the encryption-off test build
  const { w, conv } = await platformWorld(server, { env: { CONVOZ_TEST_PLAINTEXT: "1" } });
  const id = await ownerSays(w.owner, conv, "kept as written");
  const before = await deltaFrom(w.owner, "1:0");
  const stored = before.events.find((e) => e.type === "message.created.v1" && e.message_id === id);
  expect(stored, "the message event is in GET /api/sync").toBeDefined();

  // When the test tries to update a stored event row in the data file
  const db = plainDb(dataDir);
  try {
    expect(() => db.prepare("UPDATE events SET type = 'message.deleted.v1' WHERE seq = ?").run(stored!.seq)).toThrow(/events are immutable/);
    expect(() => db.prepare("UPDATE events SET payload_json = '{}' WHERE seq = ?").run(stored!.seq)).toThrow(/events are immutable/);
  } finally {
    db.close();
  }

  // Then the update is refused, and GET /api/sync returns the original event
  const after = await deltaFrom(w.owner, "1:0");
  expect(after.events.find((e) => e.seq === stored!.seq)).toEqual(stored);
  expect(after.events).toEqual(before.events);
});

scenario("A cursor from another epoch gets a reset", { tag: ["@api"] }, async ({ server }) => {
  // Given a client holds a cursor from an earlier epoch
  const { w, conv } = await platformWorld(server);
  await ownerSays(w.owner, conv, "hello");
  const now = await snapshotOf(w.owner);
  expect(now.cursor).toBe(`${now.epoch}:${now.as_of_seq}`);
  const stale = `0:${now.as_of_seq}`;

  // When it syncs with that cursor
  const res = await syncRaw(w.owner, stale);

  // Then the server answers with a "reset" and the client loads a fresh snapshot
  expect(res.status).toBe(200);
  expect(res.json()).toMatchObject({ reset: true, reason: "epoch" });
  const fresh = await snapshotOf(w.owner);
  expect(fresh.cursor).toBe(now.cursor);
  // A cursor of this epoch is not reset, and one ahead of the log is
  expect((await syncRaw(w.owner, now.cursor)).json().reset).toBeUndefined();
  expect(await syncRaw(w.owner, `${now.epoch}:${now.as_of_seq + 1000}`).then((r) => r.json())).toMatchObject({ reset: true });
});

scenario("A slow client gets a reset and resyncs", { tag: ["@browser"] }, async ({ server, page, context }, info) => {
  info.setTimeout(180_000);
  // Given a browser that stops reading the event stream
  const u = await uiWorld({ server, page, context });
  const conv = await createConversation(u.w.owner, { participants: ["devtool"], title: "Ship search filters" });
  const proxy = await stallProxy(u.w.srv.target);
  try {
    await page.goto(`${proxy.url}/chats/${conv}`);
    await expect(composer(page)).toBeVisible();
    await expect.poll(() => proxy.streams.length).toBe(1);
    proxy.stall();

    // When more than 256 frames queue for it
    // The kernel holds a megabyte or two of what the server wrote before a write blocks, so the messages are 16 KB each.
    const total = 420;
    const pad = "word ".repeat(3_180);
    for (let i = 1; i <= total; i++) await ownerSays(u.w.owner, conv, `m${i} ${pad}`);
    proxy.resume();

    // Then the server sends "reset" with reason "slow" and closes the stream
    await expect.poll(() => proxy.streams[0]!.events.at(-1)?.name, { timeout: 20_000 }).toBe("reset");
    expect(JSON.parse(proxy.streams[0]!.events.at(-1)!.data!)).toEqual({ reason: "slow" });
    await expect.poll(() => proxy.streams[0]!.closed).toBe(true);

    // And the browser resyncs and shows every message
    await expect.poll(() => heldNumbers(page), { timeout: 30_000 }).toEqual(Array.from({ length: total }, (_, i) => i + 1));
    // The transcript is virtual and each message is tall, so the newest one is shown by scrolling to the end.
    await messageLog(page).evaluate(async (el, last) => {
      for (let i = 0; i < 500 && ![...el.querySelectorAll("article")].some((a) => a.textContent?.includes(last)); i++) {
        el.scrollTop = el.scrollHeight;
        await new Promise((resolve) => requestAnimationFrame(resolve));
      }
    }, `m${total} `);
    await expect(message(page, `m${total} `)).toHaveCount(1);
    expect(proxy.streams.length).toBeGreaterThan(1); // it opened a new stream
  } finally {
    await proxy.close();
  }
});

/** The numbers n of the messages "m<n> ..." the page's offline cache (IndexedDB) holds, ascending. */
async function heldNumbers(page: import("@playwright/test").Page): Promise<number[]> {
  return page.evaluate(
    () =>
      new Promise<number[]>((resolve, reject) => {
        const open = indexedDB.open("convoz");
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const all = open.result.transaction("messages").objectStore("messages").getAll();
          all.onerror = () => reject(all.error);
          all.onsuccess = () => {
            const nums = (all.result as { body: string }[]).map((m) => /^m(\d+) /.exec(m.body)?.[1]).filter((n): n is string => n !== undefined).map(Number);
            open.result.close();
            resolve(nums.sort((a, b) => a - b));
          };
        };
      }),
  );
}

scenario("The server is serving within 500 ms of start", { tag: ["@cli"] }, async ({ server }, info) => {
  info.setTimeout(300_000);
  // Given a data dir with the 1M-message fixture
  const { w, conv } = await platformWorld(server);
  await seedMessages(w.srv, conv, 1_000_000);
  await w.srv.stop();

  // When "convoz serve" starts
  const began = performance.now();
  const again = await server();

  // Then GET /healthz answers "ok" within 500 ms
  const res = await send(again.target, "GET", "/healthz");
  const took = performance.now() - began;
  expect(res.text).toBe("ok");
  expect(took, `serve took ${Math.round(took)} ms to answer /healthz`).toBeLessThan(500);
});

// ---- written by this work package, bound once search (WP12) and the inbox mention items (WP6) landed ----------------------

scenario("A write and its event, inbox item, search entry and audit row appear together", { tag: ["@api"] }, async ({ server }) => {
  const { w, conv } = await platformWorld(server);
  const stream = await openStream(w.srv, w.owner.client);
  try {
    // When the owner posts "@devtool rotate the deploy key" in conversation 41
    const id = must(await ownerPost(w.owner, conv, "@devtool rotate the deploy key"), "owner posts", 201).json().id as number;

    // Then in the same response sequence the event stream has the message event
    const frame = await stream.waitFor((f) => f.event === "message.created" && f.data.id === id, 2_000);
    expect(frame.data.conversation_id).toBe(conv);
    expect((await deltaFrom(w.owner, "1:0")).events.some((e) => e.type === "message.created.v1" && e.message_id === id)).toBe(true);

    // And "devtool" has a mention item
    const session = await startSession(w.box, "devtool", "together");
    const items = await inboxItems(w.box, session.sid, ["--peek"]);
    expect(items.some((i) => i.reason === "mention" && i.message.id === id)).toBe(true);

    // And search finds "rotate" in conversation 41
    const found = must(await w.owner.client.get("/api/search?q=rotate"), "search").json();
    expect(JSON.stringify(found)).toContain(`"conversation_id":${conv}`);

    // And the audit view lists the post with no lag
    const audit = must(await w.owner.client.get("/api/admin/audit"), "audit").json().audit as { action: string; target_id?: number }[];
    expect(audit.some((r) => r.action === "message.post" && r.target_id === id)).toBe(true);
  } finally {
    stream.close();
  }
});
