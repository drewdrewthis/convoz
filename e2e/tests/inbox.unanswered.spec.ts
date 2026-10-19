import { chatWorld, convoz, createConversation, inboxItems, ownerSays, startSession, startWatch, watchLines } from "../lib/chat.ts";
import { must } from "../lib/owner.ts";
import { expect, scenario } from "../lib/scenario.ts";
import { planWorld, mustPlan } from "../lib/plan.ts";
import { clientId } from "../lib/machines.ts";

// inbox.feature, Rule "The owner's message that nobody answers in 10 minutes is sent to the agents once more" (owner msgs 818, 821).
// The server clock is moved with the test hook; "devtool" and "docs" are in conversation 41.

const MIN = 60_000;

/** "devtool" posts in the main chat of conversation 41. */
const agentPosts = async (p: Awaited<ReturnType<typeof planWorld>>, text: string) => {
  const res = await convoz(p.w.box, p.dev.sid, ["post", String(p.conv), text]);
  expect(res.code, res.stderr).toBe(0);
};

const unanswered = async (w: Awaited<ReturnType<typeof planWorld>>, who: { sid: string }) =>
  (await inboxItems(w.w.box, who.sid, ["--peek"])).filter((i) => i.reason === "unanswered");

scenario("The owner's last message unanswered for 10 minutes reminds the agent once", { tag: ["@cli"] }, async ({ server, testApi }) => {
  const p = await planWorld(server);
  // Given the owner posted "Is the build green?" in conversation 41 and nobody answered
  await ownerSays(p.w.owner, p.conv, "Is the build green?");

  // When 9 minutes pass, then "devtool" has no "unanswered" item
  await testApi(p.w.srv).advanceClock(9 * MIN);
  expect(await unanswered(p, p.dev)).toEqual([]);

  // When 2 more minutes pass, then "devtool" has one "unanswered" item that carries "Is the build green?"
  await testApi(p.w.srv).advanceClock(2 * MIN);
  const items = await unanswered(p, p.dev);
  expect(items.map((i) => [i.conversation.id, i.message.body, i.message.author.handle])).toEqual([[p.conv, "Is the build green?", "drew"]]);

  // And "convoz watch" prints that item with the reason "unanswered"
  const res = await p.w.box.run(["watch", "--json", "--once", "--sid", p.dev.sid], { timeoutMs: 20_000 });
  expect(res.code, res.stderr).toBe(0);
  const lines = res.stdout.split("\n").filter(Boolean).map((l) => JSON.parse(l));
  expect(lines.filter((l) => l.reason === "unanswered").map((l) => l.body)).toEqual(["Is the build green?"]);

  // When 1 hour passes, then "devtool" still has one "unanswered" item (none was made again)
  await testApi(p.w.srv).advanceClock(60 * MIN);
  expect(await unanswered(p, p.dev)).toHaveLength(1);
});

scenario("An agent's message in the same place clears the reminder", { tag: ["@cli"] }, async ({ server, testApi }) => {
  const p = await planWorld(server);
  // Given the owner posted "Is the build green?" in conversation 41
  await ownerSays(p.w.owner, p.conv, "Is the build green?");

  // When "devtool" posts "Checking" in conversation 41 and 11 minutes pass
  await agentPosts(p, "Checking");
  await testApi(p.w.srv).advanceClock(11 * MIN);

  // Then "devtool" and "docs" have no "unanswered" item
  expect(await unanswered(p, p.dev)).toEqual([]);
  expect(await unanswered(p, p.docs)).toEqual([]);

  // When the owner posts "Any news?" in a thread of conversation 41 and "devtool" posts in the main chat of conversation 41
  const root = await ownerSays(p.w.owner, p.conv, "Release notes?");
  const reply = await p.w.owner.client.post(`/api/conversations/${p.conv}/messages`, { client_id: clientId(), body: "Any news?", thread_root_id: root });
  must(reply, "owner thread reply", 201);
  await agentPosts(p, "Still on it");

  // And 11 minutes pass, then "devtool" has one "unanswered" item that carries "Any news?"
  await testApi(p.w.srv).advanceClock(11 * MIN);
  expect((await unanswered(p, p.dev)).map((i) => i.message.body)).toEqual(["Any news?"]);
});

scenario("A plan update is not an answer", { tag: ["@cli"] }, async ({ server, testApi }) => {
  const p = await planWorld(server);
  // Given the owner posted "Is the build green?" in conversation 41
  await ownerSays(p.w.owner, p.conv, "Is the build green?");

  // When "devtool" sets its plan for conversation 41 and 11 minutes pass
  await mustPlan(p, p.dev, ["--doing", "Checking the build", "--eta", "3h"]);
  await testApi(p.w.srv).advanceClock(11 * MIN);

  // Then "devtool" has one "unanswered" item that carries "Is the build green?"
  expect((await unanswered(p, p.dev)).map((i) => i.message.body)).toEqual(["Is the build green?"]);
});

scenario("A newer owner message restarts the 10 minutes", { tag: ["@cli"] }, async ({ server, testApi }) => {
  const p = await planWorld(server);
  // Given the owner posted "First question" in conversation 41
  await ownerSays(p.w.owner, p.conv, "First question");

  // When 6 minutes pass and the owner posts "Second question" in conversation 41 and 6 minutes pass
  await testApi(p.w.srv).advanceClock(6 * MIN);
  await ownerSays(p.w.owner, p.conv, "Second question");
  await testApi(p.w.srv).advanceClock(6 * MIN);

  // Then "devtool" has no "unanswered" item
  expect(await unanswered(p, p.dev)).toEqual([]);

  // When 5 more minutes pass, then "devtool" has one "unanswered" item that carries "Second question"
  await testApi(p.w.srv).advanceClock(5 * MIN);
  expect((await unanswered(p, p.dev)).map((i) => i.message.body)).toEqual(["Second question"]);
});

scenario("Only the mentioned agent is reminded", { tag: ["@cli"] }, async ({ server, testApi }) => {
  const p = await planWorld(server);
  // Given the owner posted "@devtool Is the build green?" in conversation 41
  await ownerSays(p.w.owner, p.conv, "@devtool Is the build green?");

  // When 11 minutes pass
  await testApi(p.w.srv).advanceClock(11 * MIN);

  // Then "devtool" has one "unanswered" item that carries "@devtool Is the build green?"
  expect((await unanswered(p, p.dev)).map((i) => i.message.body)).toEqual(["@devtool Is the build green?"]);

  // And "docs" has no "unanswered" item
  expect(await unanswered(p, p.docs)).toEqual([]);
});

scenario("Watch does not need an ack and does not redeliver", { tag: ["@cli"] }, async ({ server, testApi }) => {
  const w = await chatWorld(server, { agents: ["devtool"] });
  const conv = await createConversation(w.owner, { title: "Ship search filters", participants: ["devtool"] });
  const s = await startSession(w.box, "devtool", "no-ack");

  // Given "devtool" runs "convoz watch --json" and the owner posts "@devtool Is the build green?" in conversation 41
  const watch = startWatch(w.box, s.sid);
  try {
    await ownerSays(w.owner, conv, "@devtool Is the build green?");

    // When the watch prints the item and 6 minutes pass without an ack
    const [line] = await watchLines(watch, 1);
    expect(line!.body).toBe("@devtool Is the build green?");
    await testApi(w.srv).advanceClock(6 * MIN);
    await new Promise((r) => setTimeout(r, 2_500));

    // Then the watch prints nothing more and "devtool" has no item waiting
    expect(watch.stdout().split("\n").filter(Boolean)).toHaveLength(1);
    expect(await inboxItems(w.box, s.sid, ["--peek"])).toEqual([]);

    // And "convoz ack" with that item still succeeds
    const acked = await convoz(w.box, s.sid, ["ack", line!.ack]);
    expect(acked.code, acked.stderr).toBe(0);
  } finally {
    watch.stop();
  }
});
