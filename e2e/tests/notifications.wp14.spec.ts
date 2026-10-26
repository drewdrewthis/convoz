import crypto from "node:crypto";
import { Client, send } from "../lib/http.ts";
import { bearer, clientId, freshSource, plainDb, requestDeviceCode, seedUserCodes, signInBrowser, stepped } from "../lib/machines.ts";
import { addSecondPasskey } from "../lib/mobile.ts";
import { must, signIn } from "../lib/owner.ts";
import {
  ask, decrypt, fakePush, newSub, notes, pushWorld, quietAround, received, say, setSetting, settled, sleep, subscribe,
  type PushWorld, type Received, type Shown, type Sub,
} from "../lib/push-wp14.ts";
import { expect, scenario } from "../lib/scenario.ts";

// WP14: notifications.feature and contracts/notifications.feature. The contract is the block at the top of lib/push-wp14.ts.
// Page contract (the web app; role and name only): /settings has a section with heading "Notifications" and a list "Notification reasons"
// whose items are named by their text. A reason that can be turned off has a switch with the reason's name ("Mentions"); the item
// "Security alerts" reads "Always on" and has no switch and no checkbox.

/** Run an action and return the one push it causes; fails when there is none within 15 s, or more than one. */
async function onePush(w: PushWorld, action: () => Promise<unknown>): Promise<{ shown: Shown; rec: Received }> {
  const before = (await received(w.srv)).length;
  await action();
  await expect.poll(async () => (await received(w.srv)).length, { timeout: 15_000 }).toBeGreaterThan(before);
  await sleep(800);
  const now = await received(w.srv);
  expect(now.length).toBe(before + 1);
  return { shown: decrypt(w.sub, now[before]!), rec: now[before]! };
}

/** Run an action and expect no push, and one new log row (the last); returns that row. */
async function noPush(w: PushWorld, action: () => Promise<unknown>) {
  const before = { pushes: (await received(w.srv)).length, rows: notes(w.dataDir).length };
  await action();
  await expect.poll(() => notes(w.dataDir).length, { timeout: 15_000 }).toBeGreaterThan(before.rows);
  await sleep(800);
  expect((await received(w.srv)).length).toBe(before.pushes);
  return notes(w.dataDir).at(-1)!;
}

const muteForever = (dataDir: string, conv: number, on: boolean) => {
  const db = plainDb(dataDir);
  try {
    if (on) db.prepare("INSERT OR REPLACE INTO conversation_prefs (identity_id, conversation_id, muted_until, updated_at) VALUES ((SELECT identity_id FROM humans LIMIT 1), ?, 253402300799000, 1)").run(conv);
    else db.prepare("DELETE FROM conversation_prefs WHERE conversation_id = ?").run(conv);
  } finally {
    db.close();
  }
};

const serverNow = async (w: PushWorld): Promise<number> => Number(must(await w.owner.client.get("/api/now"), "now").json().now);

scenario("Triggers that push the owner", { tag: ["@api"] }, async ({ server, dataDir, testApi }, info) => {
  info.setTimeout(120_000);
  const w = await pushWorld(server, dataDir);
  const row = async (event: string, reason: string, action: () => Promise<unknown>) => {
    // When <event>
    const { shown } = await onePush(w, action);
    // Then the fake push service receives one push with the reason "<reason>"
    expect(shown.reason, event).toBe(reason);
    expect(shown.v).toBe(1);
  };
  await row('"devtool" asks a question in conversation 41', "ask", () => ask(w));
  await row('"devtool" asks an urgent question in conversation 41', "ask_urgent", () => ask(w, { urgent: true }));
  await row('"devtool" posts "@drew please look" in conversation 41', "mention", () => say(w, "@drew please look"));

  const root = await say(w, "Step 1 is the filter chips UI");
  must(await w.owner.client.post(`/api/conversations/${w.conv}/messages`, { client_id: clientId(), body: "Sounds good", thread_root_id: root }), "owner replies", 201);
  await settled(dataDir);
  await row('"devtool" replies in a thread the owner replied in', "thread_reply", () => say(w, "On it", { thread_root_id: root }));

  await row('"devtool" requests to add "@docs" to conversation 41', "agent_add", async () =>
    must(await send(w.srv.target, "POST", `/api/conversations/${w.conv}/participants`, { json: { identity_id: w.docsId }, ...bearer(w.dev) }), "agent adds", 201),
  );

  let snoozedAsk = 0;
  const first = await onePush(w, async () => { snoozedAsk = await ask(w, { question: "Ship it today?" }); });
  expect(first.shown.reason).toBe("ask");
  await row("a snoozed ask reaches its wake time", "snooze_wake", async () => {
    must(await w.owner.client.request("PUT", `/api/asks/${snoozedAsk}/snooze`, { csrf: true, json: { preset: "1h" } }), "snooze");
    await testApi(w.srv).advanceClock(61 * 60_000);
    await w.owner.client.get("/api/now"); // a read of Now wakes what came due
  });

  await seedUserCodes(w.srv, ["KQWD-MZTP"]);
  await row('"convoz login --name box-9" starts', "machine_request", () => requestDeviceCode(w.srv, "box-9", freshSource()));

  const soft2 = await addSecondPasskey(w.srv, w.owner);
  const other = new Client(w.srv.target);
  await signIn(other, soft2);
  await row('the owner reveals the key of "box-2" from another device', "security", async () =>
    must(await stepped({ client: other, soft: soft2 }, "POST", `/api/machines/${w.box.id}/reveal`, {}, "machine.reveal", w.box.id), "reveal"),
  );
});

scenario("Suppression reasons", { tag: ["@api"] }, async ({ server, dataDir }, info) => {
  info.setTimeout(90_000);
  const w = await pushWorld(server, dataDir);
  const row = async (reason: string, undo: () => Promise<unknown>) => {
    // When "devtool" asks a question in conversation 41
    const note = await noPush(w, () => ask(w));
    // Then no push is received / And the owner's notification log shows the reason "<reason>"
    expect(note.reason).toBe("ask");
    expect(note.decision).toBe("suppressed");
    expect(note.suppressed_reason).toBe(reason);
    await undo();
  };
  // Given the owner turned the "asks" setting to "none"
  await setSetting(w.owner, "notify.asks", "none");
  await row("setting_off", () => setSetting(w.owner, "notify.asks", "all"));
  // Given the owner muted conversation 41
  muteForever(dataDir, w.conv, true);
  await row("muted", async () => muteForever(dataDir, w.conv, false));
  // Given it is inside the owner's quiet hours
  await setSetting(w.owner, "notify.quiet_hours", quietAround(await serverNow(w)));
  await row("quiet_hours", () => setSetting(w.owner, "notify.quiet_hours", null));
  // Given the owner's only device has conversation 41 open and focused
  must(await w.owner.client.request("PUT", "/api/push/focus", { csrf: true, json: { conversation_id: w.conv } }), "focus", 204);
  await row("active_here", async () => must(await w.owner.client.request("PUT", "/api/push/focus", { csrf: true, json: { conversation_id: null } }), "blur", 204));
  // control: with nothing set, the same ask does push
  expect((await onePush(w, () => ask(w))).shown.reason).toBe("ask");
});

scenario("An urgent ask in quiet hours follows the bypass setting", { tag: ["@api"] }, async ({ server, dataDir }, info) => {
  info.setTimeout(60_000);
  const w = await pushWorld(server, dataDir);
  // Given it is inside the owner's quiet hours and "urgent bypass" is on
  await setSetting(w.owner, "notify.quiet_hours", quietAround(await serverNow(w)));
  await setSetting(w.owner, "notify.urgent_bypass", true);
  // When "devtool" asks an urgent question / Then the fake push service receives one push
  expect((await onePush(w, () => ask(w, { urgent: true }))).shown.reason).toBe("ask_urgent");
  // Given "urgent bypass" is off
  await setSetting(w.owner, "notify.urgent_bypass", false);
  // Then no push is received and the log shows "quiet_hours"
  const note = await noPush(w, () => ask(w, { urgent: true }));
  expect([note.reason, note.suppressed_reason]).toEqual(["ask_urgent", "quiet_hours"]);
});

scenario("A notification is not sent for what the owner can no longer see", { tag: ["@api"] }, async ({ server, dataDir }, info) => {
  info.setTimeout(60_000);
  const w = await pushWorld(server, dataDir);
  // Given "devtool" asked a question in conversation 41 (the sender is held back, so the push has not gone yet)
  await fakePush(w.srv, { hold: true });
  await ask(w);
  await expect.poll(() => notes(dataDir).filter((n) => n.reason === "ask" && n.decision === "send").length, { timeout: 15_000 }).toBe(1);
  // When the owner deletes conversation 41 before the push is sent
  must(await w.owner.client.del(`/api/conversations/${w.conv}`), "delete conversation");
  await fakePush(w.srv, { hold: false });
  // Then no push is received and the log shows "not_visible"
  await expect.poll(() => notes(dataDir).at(-1)?.suppressed_reason, { timeout: 15_000 }).toBe("not_visible");
  await sleep(800);
  expect(await received(w.srv)).toHaveLength(0);
});

scenario("Security pushes cannot be turned off", { tag: ["@browser"] }, async ({ server, dataDir, page, context }) => {
  const w = await pushWorld(server, dataDir);
  await signInBrowser(w.srv, w.owner, page, context);
  // When the owner opens the notification settings
  await page.goto(`${w.srv.origin}/settings`);
  await expect(page.getByRole("heading", { name: "Notifications", level: 2 })).toBeVisible();
  // Then the security reason shows as always on with no switch
  const security = page.getByRole("list", { name: "Notification reasons" }).getByRole("listitem").filter({ hasText: "Security alerts" });
  await expect(security).toContainText("Always on");
  await expect(security.getByRole("switch")).toHaveCount(0);
  await expect(security.getByRole("checkbox")).toHaveCount(0);
  // control: a reason that can be turned off has its switch
  await expect(page.getByRole("switch", { name: "Mentions" })).toBeVisible();
});

scenario("A gone subscription is disabled", { tag: ["@api"] }, async ({ server, dataDir }, info) => {
  info.setTimeout(60_000);
  const w = await pushWorld(server, dataDir);
  // Given the push service says the owner's subscription is gone
  await fakePush(w.srv, { status: { [w.sub.endpoint]: 410 } });
  // When "devtool" asks a question
  await ask(w);
  // Then the subscription is listed as disabled in Settings
  await expect
    .poll(async () => (await w.owner.client.get("/api/push/subscriptions")).json().subscriptions.map((s: { state: string; disabled_reason?: string }) => [s.state, s.disabled_reason]), { timeout: 15_000 })
    .toEqual([["disabled", "gone"]]);
  // And the next ask sends nothing to it
  const attempts = (await received(w.srv)).length;
  expect(attempts).toBe(1);
  const note = await noPush(w, () => ask(w));
  expect(note.suppressed_reason).toBe("no_subscription");
  expect(await received(w.srv)).toHaveLength(attempts);
});

scenario("The preview setting decides what the lock screen shows", { tag: ["@api"] }, async ({ server, dataDir, testApi }, info) => {
  info.setTimeout(60_000);
  const w = await pushWorld(server, dataDir);
  for (const [previews, title, body] of [
    ["full", "Dev Tool @devtool", "the deploy failed"],
    ["sender", "Dev Tool @devtool", "New message"],
    ["none", "Convoz", "New activity"],
  ] as const) {
    // Given the preview setting is "<previews>" (each row is its own minute: pushes within 60 s of each other would read "2 new")
    await testApi(w.srv).advanceClock(2 * 60_000);
    await setSetting(w.owner, "notify.previews", previews);
    // When "devtool" posts "@drew the deploy failed" in conversation 41
    const { shown } = await onePush(w, () => say(w, "@drew the deploy failed"));
    // Then the decrypted push reads title "<title>" and body "<body>"
    expect([shown.title, shown.body]).toEqual([title, body]);
  }
});

scenario("A replayed event never pushes twice", { tag: ["@api"] }, async ({ server, dataDir }, info) => {
  info.setTimeout(90_000);
  const w = await pushWorld(server, dataDir);
  // Given "devtool" asked a question and the owner got one push
  expect((await onePush(w, () => ask(w))).shown.reason).toBe("ask");
  // When the server restarts while the push worker is mid-batch (its offset is back at the start, so it reads every event again)
  await fakePush(w.srv, { rewind: true });
  await w.srv.stop();
  const srv2 = await server({ host: "localhost", adminSocket: true, env: { CONVOZ_TEST_POLL_MS: "250", CONVOZ_TEST_PLAINTEXT: "1" } });
  await settled(dataDir);
  await sleep(2_500);
  // Then the fake push service has still received one push for that ask
  const all = await received(srv2);
  expect(all.map((r) => decrypt(w.sub, r).reason)).toEqual(["ask"]);
  expect(notes(dataDir).filter((n) => n.reason === "ask")).toHaveLength(1);
});

scenario("Bursts in one conversation coalesce", { tag: ["@api"] }, async ({ server, dataDir }, info) => {
  info.setTimeout(60_000);
  const w = await pushWorld(server, dataDir);
  // When "devtool" posts 3 mentions of "@drew" in conversation 41 within 60 seconds
  for (const text of ["@drew first", "@drew second", "@drew third"]) await say(w, text);
  await expect.poll(async () => (await received(w.srv)).length, { timeout: 15_000 }).toBe(3);
  // Then the fake push service ends with one visible push for that topic reading "3 new"
  const all = await received(w.srv);
  expect(new Set(all.map((r) => r.topic)).size).toBe(1); // one Topic: the push service keeps only the newest
  expect(decrypt(w.sub, all.at(-1)!).body).toBe("3 new");
});

scenario("A machine request pushes even in quiet hours", { tag: ["@api"] }, async ({ server, dataDir }, info) => {
  info.setTimeout(60_000);
  const w = await pushWorld(server, dataDir);
  // Given it is inside the owner's quiet hours
  await setSetting(w.owner, "notify.quiet_hours", quietAround(await serverNow(w)));
  // When "convoz login --name box-9" starts
  await seedUserCodes(w.srv, ["KQWD-MZTP"]);
  const { shown } = await onePush(w, () => requestDeviceCode(w.srv, "box-9", freshSource()));
  // Then the fake push service receives "box-9 wants to connect" with the body "code KQWD-MZTP"
  expect([shown.reason, shown.title, shown.body]).toEqual(["machine_request", "box-9 wants to connect", "code KQWD-MZTP"]);
});

scenario("Only allow-listed push hosts are accepted", { tag: ["@api"] }, async ({ server, dataDir }) => {
  const w = await pushWorld(server, dataDir);
  for (const [endpoint, status] of [
    ["https://fcm.googleapis.com/fcm/send/abc", 201],
    ["https://fcm.googleapis.com.evil.tld/send/abc", 400],
    ["https://x@fcm.googleapis.com/fcm/send/abc", 400],
    ["http://fcm.googleapis.com/fcm/send/abc", 400],
  ] as const) {
    // When the owner subscribes with the endpoint "<endpoint>"
    const res = await subscribe(w.owner, newSub(), endpoint);
    // Then the server answers <status>
    expect(res.status, endpoint).toBe(status);
  }
});

scenario("The push service sees no ids and no exact sizes", { tag: ["@api"] }, async ({ server, dataDir }, info) => {
  info.setTimeout(60_000);
  const w = await pushWorld(server, dataDir);
  // When "devtool" asks 3 questions
  const ids: number[] = [];
  for (let i = 0; i < 3; i++) ids.push(await ask(w, { question: `Question number ${i} with some words to make it longer ${"x".repeat(i * 200)}` }));
  await expect.poll(async () => (await received(w.srv)).length, { timeout: 15_000 }).toBe(3);
  // Then every Topic header the fake service received is 22 characters and holds no ask id
  const all = await received(w.srv);
  expect(new Set(all.map((r) => r.topic)).size).toBe(3);
  for (const [i, r] of all.entries()) {
    const id = ids[i]!;
    expect(r.topic).toHaveLength(22);
    expect(r.topic).not.toBe(String(id));
    expect(r.topic).not.toBe(crypto.createHash("sha256").update(`a${id}`).digest("base64url").slice(0, 22)); // not a plain hash anyone could recompute
    // And every payload size is a multiple of 512 bytes
    expect(r.size % 512).toBe(0);
  }
});
