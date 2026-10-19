import { agentAsks, answerAsk, askOf, snoozeAsk } from "../lib/asks.ts";
import { agentSays, convoz, createConversation, exitsWithin, inboxItems, ownerSays, peekFor, startSession } from "../lib/chat.ts";
import { conversationsWithMentions, inboxApi, itemsOf } from "../lib/inbox.ts";
import { DAY_MS, HOUR_MS, inboxWorld } from "../lib/left.ts";
import { clientId, plainDb } from "../lib/machines.ts";
import { must } from "../lib/owner.ts";
import { send } from "../lib/http.ts";
import { expect, scenario } from "../lib/scenario.ts";
import { idsOf, ownerDeletes, ownerRemoves } from "../lib/wp3.ts";

// Bindings of the inbox scenarios that work package 6 left open (inbox.feature, contracts/inbox.feature). Not bound here, because they
// need a work package that is still running: "Each kind of event makes an item with its reason" and "Answers, membership changes and app
// results stay separate items" (app results: the apps host), and the two voice scenarios (the transcription engine).
// Names: "s1", "s2" are sessions of "devtool" on "box-2"; conversation 41 is the first conversation of each world.

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const MAINTENANCE = "/__test/maintenance";

// ---- inbox.feature ---------------------------------------------------------------------------------------

scenario("Snoozing an ask makes no inbox item", { tag: ["@cli"] }, async ({ server }) => {
  // Given "devtool" has an open ask in conversation 41
  const { w, conv, s1 } = await inboxWorld(server);
  const id = await agentAsks(w.srv, s1.lease, conv);
  const before = (await inboxItems(w.box, s1.sid, ["--peek"])).map((i) => i.id);

  // When the owner snoozes it for 1 hour
  const snoozed = await snoozeAsk(w.owner, id, { preset: "1h" });
  expect(snoozed.status).toBe(200);

  // Then "convoz inbox --peek --sid s1" shows no new item
  const after = await inboxItems(w.box, s1.sid, ["--peek"]);
  expect(after.map((i) => i.id)).toEqual(before);
  expect(after.filter((i) => i.reason === "ask_resolved")).toEqual([]);
});

scenario("Thread replies join the conversation item", { tag: ["@cli"] }, async ({ server }) => {
  // Given "devtool" started thread 900 in conversation 41
  const { w, conv, s1 } = await inboxWorld(server);
  const root = await agentSays(w.srv, s1.lease, conv, "Step 1 is the filter chips UI");

  // When the owner posts 5 replies in thread 900 and 2 messages in the main list
  for (let i = 1; i <= 5; i++) {
    must(await w.owner.client.post(`/api/conversations/${conv}/messages`, { client_id: clientId(), body: `reply ${i}`, thread_root_id: root }), `reply ${i}`, 201);
  }
  await ownerSays(w.owner, conv, "main one");
  await ownerSays(w.owner, conv, "main two");

  // Then "convoz inbox --peek --sid s1" shows 1 item for conversation 41 with reason "thread" and count 7
  const items = await peekFor(w.box, s1.sid, conv);
  expect(items.map((i) => [i.reason, i.count])).toEqual([["thread", 7]]);
});

scenario("One message makes one item and the strongest reason wins", { tag: ["@cli"] }, async ({ server }) => {
  // Given "devtool" asked a question in conversation 41
  const { w, conv, s1 } = await inboxWorld(server);
  const id = await agentAsks(w.srv, s1.lease, conv);

  // When the owner answers it with the custom text "@devtool merge it after lunch"
  const answered = await answerAsk(w.owner, id, { choice: "custom", text: "@devtool merge it after lunch" });
  expect(answered.status).toBe(200);

  // Then "devtool" gets one "ask_resolved" item for that answer and no mention item for it
  const items = await peekFor(w.box, s1.sid, conv);
  expect(items.map((i) => i.reason)).toEqual(["ask_resolved"]);
  expect((items[0]!.message as unknown as { ask?: { answer?: string } }).ask?.answer).toBe("@devtool merge it after lunch");
});

scenario("Acking an answer item marks the ask as acked", { tag: ["@cli"] }, async ({ server }) => {
  // Given the owner answered the ask of "devtool" in conversation 41
  const { w, conv, s1 } = await inboxWorld(server);
  const id = await agentAsks(w.srv, s1.lease, conv);
  expect((await answerAsk(w.owner, id, { choice: "recommended" })).status).toBe(200);
  expect((await askOf(w.owner, id)).acked_at).toBeUndefined();

  // When session "s1" claims and acks the "ask_resolved" item
  const claimed = (await inboxItems(w.box, s1.sid, ["--claim", "5", "--wait", "0"])).filter((i) => i.reason === "ask_resolved");
  expect(claimed).toHaveLength(1);
  const acked = await convoz(w.box, s1.sid, ["ack", `${claimed[0]!.id}:${claimed[0]!.claim_token}`]);
  expect(acked.code, acked.stderr).toBe(0);

  // Then the owner sees "Seen by @devtool" on the answered ask
  expect((await askOf(w.owner, id)).acked_at).toBeGreaterThan(0);
});

scenario("An item delivered 5 times is expired before the next claim", { tag: ["@cli"] }, async ({ server, testApi }) => {
  // Given a mention item that was delivered 5 times and never acked
  const { w, conv, s1 } = await inboxWorld(server);
  await ownerSays(w.owner, conv, "@devtool the poisoned one");
  const others = await conversationsWithMentions(w.owner, 3, "devtool"); // And 3 other ready items
  for (let delivery = 1; delivery <= 5; delivery++) {
    const [got] = await inboxItems(w.box, s1.sid, ["--conv", String(conv), "--claim", "1", "--wait", "0", "--visibility", "30s"]);
    expect(got?.reason).toBe("mention");
    await testApi(w.srv).advanceClock(31_000);
  }

  // When session "s1" runs "convoz claim 10"
  const claim = await convoz(w.box, s1.sid, ["claim", "10", "--json"]);
  expect(claim.code, claim.stderr).toBe(0);

  // Then it gets the 3 other items and not the expired one
  const items = JSON.parse(claim.stdout).items as { conversation: { id: number } }[];
  expect(items.map((i) => i.conversation.id).sort()).toEqual([...others].sort());

  // And "convoz brief" reports "1 item expired unread" with conversation 41
  const brief = await convoz(w.box, s1.sid, ["brief"]);
  expect(brief.code, brief.stderr).toBe(0);
  const expired = brief.stdout.slice(brief.stdout.indexOf("## Expired unread"));
  expect(expired).toContain("1 item expired unread");
  expect(expired).toContain(`conversation ${conv} "Ship search filters"`);
});

scenario("An item goes to the session that posted last in that conversation", { tag: ["@cli"] }, async ({ server }) => {
  // Given session "s2" posted in conversation 41 after session "s1"
  const { w, conv, s1, s2 } = await inboxWorld(server);
  for (const [s, text] of [[s1, "first"], [s2, "second"]] as const) {
    const posted = await convoz(w.box, s.sid, ["post", String(conv), text]);
    expect(posted.code, posted.stderr).toBe(0);
  }

  // And both sessions wait with "convoz inbox --wait 60"
  const first = w.box.start(["inbox", "--json", "--sid", s1.sid, "--wait", "60"], { timeoutMs: 30_000 });
  const second = w.box.start(["inbox", "--json", "--sid", s2.sid, "--wait", "60"], { timeoutMs: 30_000 });
  try {
    await sleep(500);

    // When the owner posts "@devtool and the follow-up?" in conversation 41
    await ownerSays(w.owner, conv, "@devtool and the follow-up?");

    // Then "s2" returns the mention item
    const done = await exitsWithin(second, 3_000);
    expect(done, "s2 did not return within 3 s").not.toBeNull();
    expect((JSON.parse(done!.stdout).items as { reason: string; conversation: { id: number } }[]).map((i) => [i.reason, i.conversation.id])).toEqual([["mention", conv]]);
    expect(await exitsWithin(first, 500), "s1 took the item too").toBeNull();
  } finally {
    first.stop();
    second.stop();
  }
});

scenario("Old items are cleaned up on schedule", { tag: ["@cli"] }, async ({ server, testApi, dataDir }) => {
  // Given an acked item 7 days and 1 hour old and an unacked item 30 days and 1 hour old
  const { w, conv } = await inboxWorld(server, { plaintext: true });
  const api = testApi(w.srv);
  const other = await createConversation(w.owner, { title: "Release notes", participants: ["devtool"] });
  await ownerSays(w.owner, conv, "@devtool the old one");
  await api.advanceClock(23 * DAY_MS);
  const s3 = await startSession(w.box, "devtool", "s3"); // a lease lasts 12 hours: a new session takes the later steps
  await ownerSays(w.owner, other, "@devtool the acked one");
  const [mine] = await inboxItems(w.box, s3.sid, ["--conv", String(other), "--claim", "1", "--wait", "0"]);
  const ack = await convoz(w.box, s3.sid, ["ack", `${mine!.id}:${mine!.claim_token}`]);
  expect(ack.code, ack.stderr).toBe(0);
  await api.advanceClock(7 * DAY_MS + HOUR_MS);

  // When the nightly maintenance runs
  must(await send(w.srv.target, "POST", MAINTENANCE, { json: {} }), "nightly maintenance");

  // Then the acked item is gone from "convoz inbox --peek"
  const s4 = await startSession(w.box, "devtool", "s4");
  const db = plainDb(dataDir);
  const rows = db
    .prepare("SELECT x.id, x.state, x.expired_reason FROM inbox_items x JOIN identities i ON i.id = x.identity_id WHERE i.handle = 'devtool' AND x.reason <> 'unanswered' ORDER BY x.id")
    .all() as { id: number; state: string; expired_reason: string | null }[];
  db.close();
  expect(rows.some((r) => r.id === mine!.id), "the acked row is still stored").toBe(false);
  // (the clock jumps made the owner's old messages unanswered: those reminders are new items, not the old ones)
  expect((await inboxItems(w.box, s4.sid, ["--peek"])).filter((i) => i.reason !== "unanswered").map((i) => i.id)).toEqual([]);

  // And "convoz brief" lists the unacked one as expired unread
  expect(rows.map((r) => [r.state, r.expired_reason])).toEqual([["expired", "age"]]);
  const brief = await convoz(w.box, s4.sid, ["brief"]);
  expect(brief.code, brief.stderr).toBe(0);
  const expired = brief.stdout.slice(brief.stdout.indexOf("## Expired unread"));
  expect(expired).toContain("1 item expired unread");
  expect(expired).toContain(`conversation ${conv} "Ship search filters"`);

  // And "convoz read 41" still shows the message the expired item pointed at
  const read = await convoz(w.box, s4.sid, ["read", String(conv)]);
  expect(read.code, read.stderr).toBe(0);
  expect(read.stdout).toContain("@devtool the old one");
});

scenario("Removal leaves one notice and then nothing more", { tag: ["@cli"] }, async ({ server }) => {
  // Given "devtool" has 2 ready items for conversation 41
  const { w, conv, s1 } = await inboxWorld(server);
  const ask = await agentAsks(w.srv, s1.lease, conv);
  must(await answerAsk(w.owner, ask, { choice: "recommended" }), "answer", 200);
  await ownerSays(w.owner, conv, "@devtool one more thing");
  expect((await peekFor(w.box, s1.sid, conv)).map((i) => i.reason).sort()).toEqual(["ask_resolved", "mention"]);
  const c52 = await createConversation(w.owner, { title: "Release notes", participants: ["devtool"] }); // conversation 52, for the last step

  // When the owner removes "devtool" from conversation 41
  const ids = await idsOf(w.owner);
  must(await ownerRemoves(w.owner, conv, ids.devtool!), "remove devtool");

  // Then "convoz inbox --wait 5 --sid s1" returns one "membership" item saying "devtool" was removed from conversation 41
  const returned = await inboxItems(w.box, s1.sid, ["--claim", "20", "--wait", "5"]);
  const mine = returned.filter((i) => i.conversation.id === conv);
  expect(mine.map((i) => i.reason)).toEqual(["membership"]);
  expect(mine[0]!.message.body).toMatch(/devtool.* removed/i);
  const acked = await convoz(w.box, s1.sid, ["ack", `${mine[0]!.id}:${mine[0]!.claim_token}`]);
  expect(acked.code, acked.stderr).toBe(0);

  // And no other item for conversation 41 arrives, even when the owner posts there again
  await ownerSays(w.owner, conv, "is anyone there?");
  expect(await peekFor(w.box, s1.sid, conv)).toEqual([]);

  // And items for "devtool" in conversation 52 still arrive
  await ownerSays(w.owner, c52, "@devtool and here?");
  expect((await peekFor(w.box, s1.sid, c52)).map((i) => i.reason)).toEqual(["mention"]);
});

scenario("Delivery checks visibility again", { tag: ["@cli"] }, async ({ server }) => {
  // Given "devtool" has a ready mention item for conversation 41
  const { w, conv, s1 } = await inboxWorld(server);
  await ownerSays(w.owner, conv, "@devtool before the trash");
  expect((await peekFor(w.box, s1.sid, conv)).map((i) => i.reason)).toEqual(["mention"]);

  // When the owner soft-deletes conversation 41
  must(await ownerDeletes(w.owner, conv), "delete conversation 41");

  // Then "convoz inbox --wait 2 --sid s1" returns no item for conversation 41
  const items = await inboxItems(w.box, s1.sid, ["--claim", "20", "--wait", "2"]);
  expect(items.filter((i) => i.conversation.id === conv)).toEqual([]);
});

// ---- contracts/inbox.feature -----------------------------------------------------------------------------

scenario("The preferred session has 30 seconds before others may take an item", { tag: ["@api"] }, async ({ server, testApi }) => {
  // Given session "s2" posted last in conversation 41 and is live but not polling
  const { w, conv, s1, s2 } = await inboxWorld(server);
  await agentSays(w.srv, s2.lease, conv, "I am on it");

  // When the owner posts "@devtool ping" in conversation 41 and "s1" polls at once and again 31 seconds later
  await ownerSays(w.owner, conv, "@devtool ping");
  const first = await itemsOf(await inboxApi(w.srv, s1.lease, "claim=1"));
  await testApi(w.srv).advanceClock(31_000);
  const second = await itemsOf(await inboxApi(w.srv, s1.lease, "claim=1"));

  // Then the first poll of "s1" returns no item and the second returns the mention
  expect(first).toEqual([]);
  expect(second.map((i) => [i.reason, i.conversation.id])).toEqual([["mention", conv]]);
});
