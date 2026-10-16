import {
  chatWorld,
  convoz,
  createConversation,
  exitsWithin,
  inboxItems,
  ownerPost,
  ownerSays,
  peekFor,
  startSession,
  startWatch,
  watchLines,
} from "../lib/chat.ts";
import { expect, scenario } from "../lib/scenario.ts";

// The contract these bindings rely on is the comment block at the top of chat-api.spec.ts.

// ---- inbox.feature ---------------------------------------------------------------------------------------

scenario("An agent's own messages create no item for itself", { tag: ["@cli"] }, async ({ server }) => {
  // Given conversation 41 "Ship search filters" has "devtool" and "docs", and sessions "s1" and "s2" of "devtool" run on "box-2"
  const w = await chatWorld(server, { agents: ["devtool", "docs"] });
  const conv = await createConversation(w.owner, { title: "Ship search filters", participants: ["devtool", "docs"] });
  const s1 = await startSession(w.box, "devtool", "s1");
  const s2 = await startSession(w.box, "devtool", "s2");
  const docs = await startSession(w.box, "docs", "docs");

  // When session "s1" posts "Starting on it" in conversation 41
  const posted = await convoz(w.box, s1.sid, ["post", String(conv), "Starting on it"]);
  expect(posted.code, posted.stderr).toBe(0);

  // Then "convoz inbox --peek --sid s2" shows no item for that message
  expect(await peekFor(w.box, s2.sid, conv)).toEqual([]);

  // And "convoz inbox --peek" as "docs" shows 1 "activity" item for conversation 41
  expect((await peekFor(w.box, docs.sid, conv)).map((i) => i.reason)).toEqual(["activity"]);
});

scenario("An unacked item comes back to another session", { tag: ["@cli"] }, async ({ server, testApi }) => {
  // Given session "s1" claimed a mention item with a 30-second visibility
  const w = await chatWorld(server, { agents: ["devtool"] });
  const conv = await createConversation(w.owner, { title: "Ship search filters", participants: ["devtool"] });
  const s1 = await startSession(w.box, "devtool", "s1");
  const s2 = await startSession(w.box, "devtool", "s2");
  await ownerSays(w.owner, conv, "@devtool status?");
  const [claimed] = await inboxItems(w.box, s1.sid, ["--claim", "1", "--wait", "0", "--visibility", "30s"]);
  expect(claimed?.claim_token).toBeTruthy();

  // When "s1" does not ack and the visibility passes
  await testApi(w.srv).advanceClock(31_000);

  // Then "s2" returns the same item with a new claim token
  const [again] = await inboxItems(w.box, s2.sid, ["--claim", "1", "--wait", "5"]);
  expect(again?.id).toBe(claimed!.id);
  expect(again?.claim_token).not.toBe(claimed!.claim_token);
});

// ---- cli-mcp.feature: the watch stream -------------------------------------------------------------------------

scenario("The owner's reply is one line in the watch stream", { tag: ["@cli"] }, async ({ server }) => {
  // Given "convoz watch --json" runs as "devtool"
  const w = await chatWorld(server, { agents: ["devtool"] });
  const conv = await createConversation(w.owner, { title: "Ship search filters", participants: ["devtool"] });
  const s = await startSession(w.box, "devtool", "watch");
  const watch = startWatch(w.box, s.sid);
  try {
    // When the owner posts "@devtool yes" in conversation 41
    const id = await ownerSays(w.owner, conv, "@devtool yes");

    // Then the stream prints exactly one JSON line for that message within 3 seconds
    const [line] = await watchLines(watch, 1, 3_000);
    expect({ body: line?.body, message_id: line?.message_id, conversation_id: line?.conversation_id, author: line?.author }).toEqual({
      body: "@devtool yes",
      message_id: id,
      conversation_id: conv,
      author: "drew",
    });
  } finally {
    watch.stop();
  }
});

scenario("A double submit gives one watch line", { tag: ["@cli"] }, async ({ server }) => {
  // Given "convoz watch --json" runs as "devtool"
  const w = await chatWorld(server, { agents: ["devtool"] });
  const conv = await createConversation(w.owner, { title: "Ship search filters", participants: ["devtool"] });
  const s = await startSession(w.box, "devtool", "watch");
  const watch = startWatch(w.box, s.sid);
  try {
    // When the owner's client sends "@devtool yes" twice with the same client id
    await ownerPost(w.owner, conv, "@devtool yes", { clientId: "c-double-aaaa" });
    await ownerPost(w.owner, conv, "@devtool yes", { clientId: "c-double-aaaa" });
    await watchLines(watch, 1, 3_000);

    // Then the stream prints one line for it (a later message is the next line, so no copy came between)
    await ownerSays(w.owner, conv, "after");
    const lines = await watchLines(watch, 2, 5_000);
    expect(lines.map((l) => [l.body, l.count])).toEqual([
      ["@devtool yes", 1],
      ["after", 1],
    ]);
  } finally {
    watch.stop();
  }
});

scenario("A two-line message stays on one watch line", { tag: ["@cli"] }, async ({ server }) => {
  // Given "convoz watch --json" runs as "devtool"
  const w = await chatWorld(server, { agents: ["devtool"] });
  const conv = await createConversation(w.owner, { title: "Ship search filters", participants: ["devtool"] });
  const s = await startSession(w.box, "devtool", "watch");
  const watch = startWatch(w.box, s.sid);
  try {
    // When the owner posts a two-line message mentioning "@devtool"
    await ownerSays(w.owner, conv, "@devtool line one\nline two");
    await watchLines(watch, 1, 3_000);

    // Then the stream line holds an escaped newline and the output has no extra line
    // (the next message is line 2 and both lines parse as JSON, so the first was not split)
    await ownerSays(w.owner, conv, "after");
    const lines = await watchLines(watch, 2, 5_000);
    expect(lines.map((l) => l.body)).toEqual(["@devtool line one\nline two", "after"]);
    expect(watch.stdout().split("\n")[0]).toContain("\\n");
  } finally {
    watch.stop();
  }
});

scenario("Watch leaves the item in the inbox until the agent acks it", { tag: ["@cli"] }, async ({ server }) => {
  // Given "convoz watch --json" runs as "devtool"
  const w = await chatWorld(server, { agents: ["devtool"] });
  const conv = await createConversation(w.owner, { title: "Ship search filters", participants: ["devtool"] });
  const s = await startSession(w.box, "devtool", "watch");
  const watch = startWatch(w.box, s.sid);
  try {
    // And the owner posts "Is the build green?" in conversation 41, and the stream printed one line for it
    await ownerSays(w.owner, conv, "Is the build green?");
    const [line] = await watchLines(watch, 1, 3_000);

    // Then "convoz inbox --peek" still shows the item for conversation 41
    expect((await peekFor(w.box, s.sid, conv)).map((i) => i.id)).toEqual([line!.item_id]);

    // When "devtool" runs "convoz post 41 'Yes, all 11 checks pass'" and then "convoz ack" with the item from the stream line
    const posted = await convoz(w.box, s.sid, ["post", String(conv), "Yes, all 11 checks pass"]);
    expect(posted.code, posted.stderr).toBe(0);
    const acked = await convoz(w.box, s.sid, ["ack", `${line!.item_id}:${line!.claim_token}`]);
    expect(acked.code, acked.stdout + acked.stderr).toBe(0);

    // Then "convoz inbox --peek" shows no item for conversation 41
    expect(await peekFor(w.box, s.sid, conv)).toEqual([]);
  } finally {
    watch.stop();
  }
});

scenario("Watch stops with exit 3 when its session ends", { tag: ["@cli"] }, async ({ server }) => {
  // Given "convoz watch --json" runs as "devtool"
  const w = await chatWorld(server, { agents: ["devtool"] });
  await createConversation(w.owner, { title: "Ship search filters", participants: ["devtool"] });
  const s = await startSession(w.box, "devtool", "watch");
  const watch = startWatch(w.box, s.sid);
  try {
    // When the session ends (another process ends the lease while the watch waits)
    const ended = await w.box.sessionEnd(s.sid);
    expect(ended.code, ended.stderr).toBe(0);

    // Then "convoz watch" exits 3 and says the session ended
    const res = await exitsWithin(watch, 8_000);
    expect({ code: res?.code, says: /session ended/i.test(res?.stderr ?? "") }).toEqual({ code: 3, says: true });
  } finally {
    watch.stop();
  }
});

// ---- cli-mcp.feature: post, read and ack --------------------------------------------------------------------

scenario("Post prints only the message id", { tag: ["@cli"] }, async ({ server }) => {
  // Given "devtool" is an active participant of conversation 41
  const w = await chatWorld(server, { agents: ["devtool"] });
  const conv = await createConversation(w.owner, { title: "Ship search filters", participants: ["devtool"] });
  const s = await startSession(w.box, "devtool", "post");

  // When "devtool" runs "convoz post 41 'Build is green'"
  const res = await convoz(w.box, s.sid, ["post", String(conv), "Build is green"]);

  // Then the CLI prints one line holding the message id and exits 0
  expect({ code: res.code, stdout: res.stdout.replace(/^\d+\n$/, "<id>\n"), stderr: res.stderr }).toEqual({ code: 0, stdout: "<id>\n", stderr: "" });
});

scenario("Ack removes an item and refuses a stale claim", { tag: ["@cli"] }, async ({ server }) => {
  // Given "devtool" claimed an item for conversation 41 and acked it
  const w = await chatWorld(server, { agents: ["devtool"] });
  const conv = await createConversation(w.owner, { title: "Ship search filters", participants: ["devtool"] });
  const s = await startSession(w.box, "devtool", "ack");
  await ownerSays(w.owner, conv, "Is the build green?");
  const [item] = await inboxItems(w.box, s.sid, ["--claim", "1", "--wait", "0"]);
  const ref = `${item!.id}:${item!.claim_token}`;
  const first = await convoz(w.box, s.sid, ["ack", ref]);
  expect(first.code, first.stdout + first.stderr).toBe(0);

  // When "devtool" acks the same item again
  const again = await convoz(w.box, s.sid, ["ack", ref]);

  // Then the CLI exits 4 with "claim_lost"
  expect({ code: again.code, says: again.stdout.includes("claim_lost") }).toEqual({ code: 4, says: true });
});

// ---- conversations.feature -----------------------------------------------------------------------------------

scenario("An agent reads what the owner wrote", { tag: ["@cli"] }, async ({ server }) => {
  // Given the owner sent "Is the build green?" in conversation 41
  const w = await chatWorld(server, { agents: ["devtool"] });
  const conv = await createConversation(w.owner, { title: "Ship search filters", participants: ["devtool"] });
  const s = await startSession(w.box, "devtool", "read");
  await ownerSays(w.owner, conv, "Is the build green?");

  // When "devtool" runs "convoz read 41"
  const res = await convoz(w.box, s.sid, ["read", String(conv)]);

  // Then the output shows "@drew" and "Is the build green?"
  expect(res.stdout).toMatch(/^#\d+ @drew \d{4}-\d\d-\d\dT\S+\n  Is the build green\?\n/m);

  // And a flag after the conversation id works, and a message cannot send control sequences to the terminal
  await ownerSays(w.owner, conv, "plain \u001b[31mred\u001b]0;pwned\u0007 text");
  const last = await convoz(w.box, s.sid, ["read", String(conv), "--since", String(1), "--limit", "5"]);
  expect(last.code, last.stderr).toBe(0);
  expect(last.stdout).toContain("plain [31mred]0;pwned text");
  expect(last.stdout).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/);
});
