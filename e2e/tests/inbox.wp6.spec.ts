import { installedMachine } from "../lib/cli.ts";
import {
  chatWorld,
  convoz,
  createConversation,
  exitsWithin,
  inboxItems,
  ownerSays,
  peekFor,
  startSession,
} from "../lib/chat.ts";
import { ackApi, conversationsWithMentions, inboxApi, inboxProxy, itemsOf, peekApi, type Item } from "../lib/inbox.ts";
import { send } from "../lib/http.ts";
import { bearer, plainDb } from "../lib/machines.ts";
import { expect, scenario } from "../lib/scenario.ts";

// Bindings of inbox.feature and contracts/inbox.feature (work package 6). The routes are described in the contract block at
// the top of chat-api.spec.ts and in lib/inbox.ts. Test names: "s1", "s2" are sessions of "devtool" on "box-2".

const PLAIN = { CONVOZ_TEST_PLAINTEXT: "1" };
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const asItems = (v: unknown) => v as Item[];

// ---- inbox.feature ---------------------------------------------------------------------------------------

scenario("A mention reaches the inbox at once", { tag: ["@cli"] }, async ({ server }) => {
  // Given "devtool" and "docs" are active participants of conversation 41 "Ship search filters", and sessions "s1" and "s2" of "devtool" run on "box-2"
  const w = await chatWorld(server, { agents: ["devtool", "docs"] });
  const conv = await createConversation(w.owner, { title: "Ship search filters", participants: ["devtool", "docs"] });
  const s1 = await startSession(w.box, "devtool", "s1");

  // And session "s1" waits with "convoz inbox --wait 60"
  const waiting = w.box.start(["inbox", "--json", "--sid", s1.sid, "--wait", "60"], { timeoutMs: 30_000 });
  try {
    await sleep(500);

    // When the owner posts "@devtool can you check the flaky test?" in conversation 41
    const id = await ownerSays(w.owner, conv, "@devtool can you check the flaky test?");

    // Then "s1" returns 1 item with reason "mention", conversation 41 and the message id within 1 second
    const done = await exitsWithin(waiting, 1_000);
    expect(done, "the waiting inbox call did not return within 1 s").not.toBeNull();
    const items = asItems(JSON.parse(done!.stdout).items);
    expect(items.map((i) => [i.reason, i.conversation.id, i.message.id])).toEqual([["mention", conv, id]]);
  } finally {
    waiting.stop();
  }
});

scenario("Thirty messages make one activity item", { tag: ["@cli"] }, async ({ server }) => {
  // Given "devtool" is an active participant of conversation 41 and session "s1" of "devtool" runs on "box-2"
  const w = await chatWorld(server, { agents: ["devtool"] });
  const conv = await createConversation(w.owner, { title: "Ship search filters", participants: ["devtool"] });
  const s1 = await startSession(w.box, "devtool", "s1");

  // When the owner posts 30 messages in conversation 41
  let newest = 0;
  for (let i = 1; i <= 30; i++) newest = await ownerSays(w.owner, conv, `message ${i}`);

  // Then "convoz inbox --peek --sid s1" shows 1 "activity" item for conversation 41 with count 30
  const items = await peekFor(w.box, s1.sid, conv);
  expect(items.map((i) => [i.reason, i.count])).toEqual([["activity", 30]]);

  // And the item points at the newest of the 30 messages
  expect(items[0]!.message.id).toBe(newest);
});

scenario("A mention raises the conversation item to a mention", { tag: ["@cli"] }, async ({ server }) => {
  // Given the owner posted 3 messages in conversation 41
  const w = await chatWorld(server, { agents: ["devtool"] });
  const conv = await createConversation(w.owner, { title: "Ship search filters", participants: ["devtool"] });
  const s1 = await startSession(w.box, "devtool", "s1");
  for (const body of ["one", "two", "three"]) await ownerSays(w.owner, conv, body);

  // When the owner posts "@devtool can you take this?" in conversation 41
  await ownerSays(w.owner, conv, "@devtool can you take this?");

  // Then "convoz inbox --peek --sid s1" shows 1 item for conversation 41 with reason "mention" and count 4
  const items = asItems(await peekFor(w.box, s1.sid, conv));
  expect(items.map((i) => [i.reason, i.count])).toEqual([["mention", 4]]);

  // And the item says 1 of the 4 messages mentions "devtool"
  expect(items[0]!.mention_count).toBe(1);
});

scenario("A new mention goes to exactly one of two waiting sessions", { tag: ["@cli"] }, async ({ server }) => {
  // Given sessions "s1" and "s2" both wait with "convoz inbox --wait 60"
  const w = await chatWorld(server, { agents: ["devtool"] });
  const conv = await createConversation(w.owner, { title: "Ship search filters", participants: ["devtool"] });
  const s1 = await startSession(w.box, "devtool", "s1");
  const s2 = await startSession(w.box, "devtool", "s2");
  const first = w.box.start(["inbox", "--json", "--sid", s1.sid, "--wait", "60"], { timeoutMs: 30_000 });
  const second = w.box.start(["inbox", "--json", "--sid", s2.sid, "--wait", "60"], { timeoutMs: 30_000 });
  try {
    await sleep(500);

    // When the owner posts "@devtool status?" in conversation 41
    await ownerSays(w.owner, conv, "@devtool status?");

    // Then exactly one of "s1" and "s2" returns the mention item
    const winner = await Promise.race([first.done.then(() => first), second.done.then(() => second)]);
    const loser = winner === first ? second : first;
    expect(asItems(JSON.parse(winner.stdout()).items).map((i) => i.reason)).toEqual(["mention"]);

    // And the other is still waiting
    expect(await exitsWithin(loser, 1_500)).toBeNull();
  } finally {
    first.stop();
    second.stop();
  }
});

scenario("An ack with an old claim token is refused", { tag: ["@cli"] }, async ({ server, testApi }) => {
  // Given session "s1" claimed a mention item with a 2-second visibility
  // (30 s is the shortest claim the server allows; the test clock moves past it)
  const w = await chatWorld(server, { agents: ["devtool"] });
  const conv = await createConversation(w.owner, { title: "Ship search filters", participants: ["devtool"] });
  const s1 = await startSession(w.box, "devtool", "s1");
  const s2 = await startSession(w.box, "devtool", "s2");
  await ownerSays(w.owner, conv, "@devtool status?");
  const [old] = await inboxItems(w.box, s1.sid, ["--claim", "1", "--wait", "0", "--visibility", "30s"]);
  expect(old?.claim_token).toBeTruthy();

  // And the item returned to session "s2" after the claim expired
  await testApi(w.srv).advanceClock(31_000);
  const [taken] = await inboxItems(w.box, s2.sid, ["--claim", "1", "--wait", "0"]);
  expect(taken?.id).toBe(old!.id);

  // When session "s1" acks the item with its old claim token
  const ack = await convoz(w.box, s1.sid, ["ack", `${old!.id}:${old!.claim_token}`]);

  // Then the CLI exits 4 with the code "claim_lost"
  expect({ code: ack.code, stdout: ack.stdout.includes("claim_lost"), stderr: ack.stderr.includes("claim_lost") }).toEqual({ code: 4, stdout: true, stderr: true });

  // And the item is still held by "s2"
  const [held] = await inboxItems(w.box, s2.sid, ["--peek"]);
  expect({ id: held?.id, state: held?.state, token: held?.claim_token }).toEqual({ id: old!.id, state: "claimed", token: taken!.claim_token });
});

scenario("A lost long-poll response loses nothing", { tag: ["@cli"] }, async ({ server, dataDir }) => {
  // Given a fault proxy drops the response that delivers a mention to session "s1"
  const w = await chatWorld(server, { agents: ["devtool"], env: PLAIN });
  const conv = await createConversation(w.owner, { title: "Ship search filters", participants: ["devtool"] });
  const proxy = await inboxProxy(w.srv.target, { maxDrops: 1 });
  try {
    const viaProxy = await installedMachine(proxy.url, "box-2", w.box2.key);
    const s1 = await startSession(viaProxy, "devtool", "s1");
    await ownerSays(w.owner, conv, "@devtool deploy?");
    const lost = await convoz(viaProxy, s1.sid, ["inbox", "--json", "--claim", "1"]);
    expect({ dropped: proxy.drops(), failed: lost.code !== 0 }).toEqual({ dropped: 1, failed: true });
    const db = plainDb(dataDir);
    const stored = db.prepare("SELECT id, lower(hex(claim_token)) AS token FROM inbox_items").all() as { id: number; token: string }[];
    db.close();
    const peekBefore = asItems(await inboxItems(viaProxy, s1.sid, ["--peek"]));

    // When "s1" polls again
    const again = await inboxItems(viaProxy, s1.sid, ["--claim", "1"]);

    // Then "s1" gets the same item with the same claim token
    expect(again.map((i) => [i.id, i.claim_token])).toEqual(stored.map((r) => [r.id, r.token]));

    // And "convoz inbox --peek" shows its delivery count unchanged
    const peekAfter = asItems(await inboxItems(viaProxy, s1.sid, ["--peek"]));
    expect(peekBefore.map((i) => i.deliveries)).toEqual([1]);
    expect(peekAfter.map((i) => i.deliveries)).toEqual([1]);
  } finally {
    await proxy.close();
  }
});

scenario("Any call from the claiming session extends its claims", { tag: ["@cli"] }, async ({ server, testApi }) => {
  // Given session "s1" claimed 2 items with a 1-minute visibility
  const w = await chatWorld(server, { agents: ["devtool"] });
  const convs = await conversationsWithMentions(w.owner, 2, "devtool");
  const s1 = await startSession(w.box, "devtool", "s1");
  const s2 = await startSession(w.box, "devtool", "s2");
  const claimed = await inboxItems(w.box, s1.sid, ["--claim", "2", "--wait", "0", "--visibility", "1m"]);
  expect(claimed).toHaveLength(2);

  // When "s1" posts a message after 50 seconds
  await testApi(w.srv).advanceClock(50_000);
  const posted = await convoz(w.box, s1.sid, ["post", "--fyi", String(convs[0]), "Still on it"]);
  expect(posted.code, posted.stderr).toBe(0);

  // And "s2" polls 30 seconds later
  await testApi(w.srv).advanceClock(30_000);
  const polled = await inboxItems(w.box, s2.sid, ["--claim", "2", "--wait", "0"]);

  // Then "s2" gets neither of the 2 items
  expect(polled).toEqual([]);
});

scenario("A session can wait on one conversation only", { tag: ["@cli"] }, async ({ server }) => {
  // Given ready items for conversations 41 and 52
  const w = await chatWorld(server, { agents: ["devtool"] });
  const [c41, c52] = await conversationsWithMentions(w.owner, 2, "devtool");
  const s1 = await startSession(w.box, "devtool", "s1");
  const s2 = await startSession(w.box, "devtool", "s2");

  // When session "s1" runs "convoz inbox --conv 41 --wait 5"
  const got = await inboxItems(w.box, s1.sid, ["--conv", String(c41), "--wait", "5"]);

  // Then it gets only the items of conversation 41
  expect(got.map((i) => i.conversation.id)).toEqual([c41]);

  // And the item of conversation 52 is still ready for "s2"
  const other = await inboxItems(w.box, s2.sid, ["--claim", "5", "--wait", "0"]);
  expect(other.map((i) => i.conversation.id)).toEqual([c52]);
});

scenario("The long poll survives forced connection resets", { tag: ["@cli"] }, async ({ server }) => {
  // Given the link is the lossy profile through the stall proxy
  // (a forwarder that resets the connection of the first 3 answers that carry an item)
  const w = await chatWorld(server, { agents: ["devtool"] });
  const proxy = await inboxProxy(w.srv.target, { maxDrops: 3 });
  try {
    const viaProxy = await installedMachine(proxy.url, "box-2", w.box2.key);
    const s1 = await startSession(viaProxy, "devtool", "s1");

    // When session "s1" runs "convoz inbox --wait 60" and the proxy resets the connection 3 times
    // Then each of 5 mentions posted during the run is returned to "s1" exactly once
    const returned: number[] = [];
    for (let i = 1; i <= 5; i++) {
      const conv = await createConversation(w.owner, { title: `Topic ${i}`, participants: ["devtool"] });
      const id = await ownerSays(w.owner, conv, `@devtool mention ${i}`);
      const got = await inboxItems(viaProxy, s1.sid, ["--wait", "60"]);
      returned.push(...got.map((it) => it.message.id));
      expect(got.map((it) => it.message.id), `round ${i}`).toEqual([id]);
      const ack = await convoz(viaProxy, s1.sid, ["ack", ...got.map((it) => `${it.id}:${it.claim_token}`)]);
      expect(ack.code, ack.stdout + ack.stderr).toBe(0);
    }
    expect({ drops: proxy.drops(), distinct: new Set(returned).size, total: returned.length }).toEqual({ drops: 3, distinct: 5, total: 5 });
    expect(await inboxItems(viaProxy, s1.sid, ["--peek"])).toEqual([]);
  } finally {
    await proxy.close();
  }
});

// ---- contracts/inbox.feature -----------------------------------------------------------------------------

scenario("An expired claim merges into the ready item of its conversation", { tag: ["@cli"] }, async ({ server, testApi }) => {
  // Given session "s1" claimed the activity item of conversation 41 with a 2-second visibility
  // (30 s is the shortest claim the server allows; the test clock moves past it)
  const w = await chatWorld(server, { agents: ["devtool"] });
  const conv = await createConversation(w.owner, { title: "Ship search filters", participants: ["devtool"] });
  const s1 = await startSession(w.box, "devtool", "s1");
  const s2 = await startSession(w.box, "devtool", "s2");
  await ownerSays(w.owner, conv, "first");
  const [claimed] = await inboxItems(w.box, s1.sid, ["--claim", "1", "--wait", "0", "--visibility", "30s"]);
  expect(claimed?.reason).toBe("activity");

  // And the owner posts 4 more messages in conversation 41
  let newest = 0;
  for (let i = 1; i <= 4; i++) newest = await ownerSays(w.owner, conv, `more ${i}`);

  // When the claim expires without an ack
  await testApi(w.srv).advanceClock(31_000);

  // Then "convoz inbox --peek --sid s2" shows exactly 1 activity item for conversation 41
  const items = await peekFor(w.box, s2.sid, conv);
  expect(items.map((i) => [i.reason, i.state])).toEqual([["activity", "ready"]]);

  // And its count covers the claimed messages and the 4 new ones
  expect(items[0]!.count).toBe(claimed!.count + 4);
  expect(items[0]!.message.id).toBe(newest);
});

scenario("Two expired claims of one conversation merge into one ready item", { tag: ["@api"] }, async ({ server, testApi }) => {
  // Given session "s1" claimed the conversation item of 41, a new message arrived, and "s1" claimed that item too
  const w = await chatWorld(server, { agents: ["devtool"] });
  const conv = await createConversation(w.owner, { title: "Ship search filters", participants: ["devtool"] });
  const s1 = await startSession(w.box, "devtool", "s1");
  const s2 = await startSession(w.box, "devtool", "s2");
  await ownerSays(w.owner, conv, "one");
  expect(await itemsOf(await inboxApi(w.srv, s1.lease, "claim=5&wait=0&held=0&visibility=30s"))).toHaveLength(1);
  await ownerSays(w.owner, conv, "two");
  expect(await itemsOf(await inboxApi(w.srv, s1.lease, "claim=5&wait=0&held=0&visibility=30s"))).toHaveLength(1);

  // And the owner posted one more message in conversation 41
  const last = await ownerSays(w.owner, conv, "three");

  // When both claims expire without an ack and "s2" polls
  await testApi(w.srv).advanceClock(31_000);
  const poll = await inboxApi(w.srv, s2.lease, "peek=1");
  expect(poll.status, poll.text).toBe(200);

  // Then GET /api/inbox?peek=1 shows exactly 1 ready item for conversation 41 whose count covers all 3 messages
  const items = (await peekApi(w.srv, s2.lease)).filter((i) => i.conversation.id === conv);
  expect(items.map((i) => [i.state, i.count, i.message.id])).toEqual([["ready", 3, last]]);

  // And no request failed on the one-ready-item rule
  expect(w.srv.log()).not.toMatch(/inbox_coalesce|UNIQUE constraint/);
});

scenario("Twenty sessions racing never get the same item", { tag: ["@api"] }, async ({ server }, info) => {
  info.setTimeout(120_000); // a `-race` server is several times slower to fill with 50 conversations
  // X-2: twenty real `convoz` processes start together. Run with CONVOZ_BIN set to a `-race` testhooks build, the server
  // log would show "DATA RACE" for a race in the claim path.
  // Given 20 sessions of "devtool" and 50 ready items
  const w = await chatWorld(server, { agents: ["devtool"] });
  await conversationsWithMentions(w.owner, 50, "devtool");
  const sessions = [];
  for (let i = 0; i < 20; i++) sessions.push(await startSession(w.box, "devtool", `racer-${i}`));

  // When all 20 sessions claim at the same time
  const runs = sessions.map((s) => w.box.start(["claim", "5", "--json", "--sid", s.sid, "--timeout", "20s"], { timeoutMs: 30_000 }));
  const done = await Promise.all(runs.map((r) => r.done));
  expect(done.map((d) => d.code), done.map((d) => d.stderr).join("")).toEqual(new Array(20).fill(0));
  const first = done.flatMap((d) => asItems(JSON.parse(d.stdout).items)).map((i) => i.id);

  // Then every item is returned to at most one session
  expect(first.length).toBeGreaterThan(0);
  expect(new Set(first).size).toBe(first.length);

  // And a second claim round returns no item that was already returned
  const again = await Promise.all(sessions.map((s) => inboxApi(w.srv, s.lease, "claim=5&wait=0&held=0")));
  const second = (await Promise.all(again.map(itemsOf))).flat().map((i) => i.id);
  expect(second.filter((id) => first.includes(id))).toEqual([]);
  expect(w.srv.log()).not.toContain("DATA RACE");
});

scenario("A claim returns a claim token that the ack must carry", { tag: ["@cli"] }, async ({ server }) => {
  // Given "devtool" has a ready item in conversation 41 and session "s1" of "devtool" runs on "box-2"
  const w = await chatWorld(server, { agents: ["devtool"] });
  const conv = await createConversation(w.owner, { title: "Ship search filters", participants: ["devtool"] });
  const s1 = await startSession(w.box, "devtool", "s1");
  await ownerSays(w.owner, conv, "@devtool please ack me");

  // When session "s1" runs "convoz claim 1 --json"
  const claim = await convoz(w.box, s1.sid, ["claim", "1", "--json"]);
  expect(claim.code, claim.stderr).toBe(0);

  // Then the output holds an item id and a claim token
  const [item] = asItems(JSON.parse(claim.stdout).items);
  expect({ id: typeof item?.id, token: typeof item?.claim_token }).toEqual({ id: "number", token: "string" });

  // And "convoz ack" with that item and token answers ok
  const ack = await convoz(w.box, s1.sid, ["ack", `${item!.id}:${item!.claim_token}`]);
  expect({ code: ack.code, out: ack.stdout.trim() }).toEqual({ code: 0, out: `${item!.id} ok` });

  // And an ack of that item without a token answers 400
  const bare = await ackApi(w.srv, s1.lease, [{ id: item!.id }]);
  expect(bare.status, bare.text).toBe(400);
});

scenario("While one session holds a conversation, no other session gets its new items", { tag: ["@api"] }, async ({ server }) => {
  // Given session "s1" holds a live claim on the item of conversation 41
  const w = await chatWorld(server, { agents: ["devtool"] });
  const conv = await createConversation(w.owner, { title: "Ship search filters", participants: ["devtool"] });
  const s1 = await startSession(w.box, "devtool", "s1");
  const s2 = await startSession(w.box, "devtool", "s2");
  await ownerSays(w.owner, conv, "first");
  const [held] = await itemsOf(await inboxApi(w.srv, s1.lease, "claim=5&wait=0"));
  expect(held?.state).toBe("claimed");

  // When the owner posts again in conversation 41 and "s2" polls
  const second = await ownerSays(w.owner, conv, "second");
  const polled = await itemsOf(await inboxApi(w.srv, s2.lease, "claim=5&wait=0"));

  // Then "s2" gets no item for conversation 41
  expect(polled.filter((i) => i.conversation.id === conv)).toEqual([]);

  // And "s1" gets the new item on its next poll
  const next = await itemsOf(await inboxApi(w.srv, s1.lease, "claim=5&wait=0"));
  expect(next.map((i) => [i.id === held!.id, i.message.id])).toEqual([
    [true, held!.message.id],
    [false, second],
  ]);
});

scenario("An ack after the claim expired is refused even with the right token", { tag: ["@api"] }, async ({ server, testApi }) => {
  // Given session "s1" claimed a mention item with a 30-second visibility and made no other call
  const w = await chatWorld(server, { agents: ["devtool"] });
  const conv = await createConversation(w.owner, { title: "Ship search filters", participants: ["devtool"] });
  const s1 = await startSession(w.box, "devtool", "s1");
  const s2 = await startSession(w.box, "devtool", "s2");
  await ownerSays(w.owner, conv, "@devtool status?");
  const [claimed] = await itemsOf(await inboxApi(w.srv, s1.lease, "claim=1&wait=0&visibility=30s"));
  expect(claimed?.claim_token).toBeTruthy();

  // When the test clock moves 31 seconds and "s1" acks with its token
  await testApi(w.srv).advanceClock(31_000);
  const ack = await ackApi(w.srv, s1.lease, [{ id: claimed!.id, claim_token: claimed!.claim_token }]);

  // Then the server answers 409 with the code "claim_lost"
  expect({ status: ack.status, code: ack.json().error?.code }).toEqual({ status: 409, code: "claim_lost" });

  // And the item is ready again
  const [after] = await peekApi(w.srv, s2.lease);
  expect({ id: after?.id, state: after?.state }).toEqual({ id: claimed!.id, state: "ready" });
});

scenario("Ending a session releases its claims without breaking the one-item rule", { tag: ["@api"] }, async ({ server }) => {
  // Given session "s1" holds the conversation item of 41 and a newer item of 41 is ready
  const w = await chatWorld(server, { agents: ["devtool"] });
  const conv = await createConversation(w.owner, { title: "Ship search filters", participants: ["devtool"] });
  const s1 = await startSession(w.box, "devtool", "s1");
  const s2 = await startSession(w.box, "devtool", "s2");
  await ownerSays(w.owner, conv, "first");
  expect(await itemsOf(await inboxApi(w.srv, s1.lease, "claim=5&wait=0"))).toHaveLength(1);
  const newest = await ownerSays(w.owner, conv, "second");

  // When "s1" ends with "convoz session end"
  const ended = await send(w.srv.target, "DELETE", "/api/sessions/me", bearer(s1.lease));
  expect(ended.status, ended.text).toBe(204);

  // Then GET /api/inbox?peek=1 as "s2" shows exactly 1 ready item for conversation 41 covering both
  const items = (await peekApi(w.srv, s2.lease)).filter((i) => i.conversation.id === conv);
  expect(items.map((i) => [i.state, i.count, i.message.id])).toEqual([["ready", 2, newest]]);
});

scenario("The CLI keeps waiting across short server holds", { tag: ["@cli"] }, async ({ server }, info) => {
  info.setTimeout(120_000);
  // Given no item is ready
  const w = await chatWorld(server, { agents: ["devtool"] });
  const conv = await createConversation(w.owner, { title: "Ship search filters", participants: ["devtool"] });
  const proxy = await inboxProxy(w.srv.target);
  try {
    const viaProxy = await installedMachine(proxy.url, "box-2", w.box2.key);
    const s1 = await startSession(viaProxy, "devtool", "s1");

    // When session "s1" runs "convoz inbox --wait 60" and a mention arrives after 40 seconds
    const started = Date.now();
    const run = viaProxy.start(["inbox", "--json", "--sid", s1.sid, "--wait", "60"], { timeoutMs: 100_000 });
    await sleep(40_000);
    await ownerSays(w.owner, conv, "@devtool you there?");
    const done = await run.done;
    const elapsed = Date.now() - started;

    // Then the proxy log shows server holds of at most 25 seconds each
    expect(proxy.log.length).toBeGreaterThanOrEqual(2);
    expect(Math.max(...proxy.log.map((e) => e.ms))).toBeLessThanOrEqual(27_000);

    // And the CLI returns the mention after about 40 seconds
    expect(asItems(JSON.parse(done.stdout).items).map((i) => i.reason)).toEqual(["mention"]);
    expect(elapsed).toBeGreaterThanOrEqual(39_000);
    expect(elapsed).toBeLessThanOrEqual(46_000);
  } finally {
    await proxy.close();
  }
});
