import { agentPost, agentSays, convoz, createConversation, exitsWithin, inboxItems, ownerSays } from "../lib/chat.ts";
import { agentAsks, answerAsk, markAsk } from "../lib/asks.ts";
import { pickerResult, validApp } from "../lib/apps-wp11.ts";
import { scriptEngine, ownerSendsVoice } from "../lib/bind.ts";
import { send } from "../lib/http.ts";
import { inboxApi, type Item } from "../lib/inbox.ts";
import { inboxWorld, type InboxWorld } from "../lib/left.ts";
import { bearer, clientId } from "../lib/machines.ts";
import { must } from "../lib/owner.ts";
import { expect, scenario } from "../lib/scenario.ts";

// Bindings of the inbox scenarios that waited for the apps host, the membership notices and the transcription engine
// (inbox.feature, contracts/inbox.feature). Names: "s1", "s2" are sessions of "devtool" on "box-2"; conversation 41 is the first
// conversation of the world. The fake engine takes its time on the server clock (lib/bind.ts), so "30 seconds" moves the test clock.

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** `convoz inbox --peek --sid s1`: every item of "devtool", all conversations. */
const peekAll = (u: InboxWorld) => inboxItems(u.w.box, u.s1.sid, ["--peek"]);

/** Claim and ack everything s1 holds, so the next row of an outline starts with an empty inbox. */
async function drain(u: InboxWorld): Promise<void> {
  const items = await inboxItems(u.w.box, u.s1.sid, ["--claim", "20", "--wait", "0"]);
  if (!items.length) return;
  const acked = await convoz(u.w.box, u.s1.sid, ["ack", ...items.map((i) => `${i.id}:${i.claim_token}`)]);
  expect(acked.code, acked.stderr).toBe(0);
  expect(await peekAll(u)).toEqual([]);
}

/** The owner confirms the picker result of an app message (the owner's side of "a result through an app of devtool"). */
async function ownerSendsResult(u: InboxWorld, appMessage: number): Promise<void> {
  must(await u.w.owner.client.post(`/api/conversations/${u.conv}/messages`, { client_id: clientId(), via_app: { message_id: appMessage, result: pickerResult(["vitest"]) } }), "result through the app", 201);
}

/** "devtool" posts a picker app in conversation 41; returns its message id. */
async function devtoolPostsApp(u: InboxWorld): Promise<number> {
  const posted = await agentPost(u.w.srv, u.s1.lease, u.conv, "Pick a runner", { app: validApp("picker-single-prototype-a2") });
  return Number(must(posted, "post the picker app", 201).json().id);
}

// ---- inbox.feature ---------------------------------------------------------------------------------------

scenario("Each kind of event makes an item with its reason", { tag: ["@cli"] }, async ({ server }, info) => {
  info.setTimeout(90_000);
  const u = await inboxWorld(server);
  const { w, conv, s1 } = u;
  const other = await createConversation(w.owner, { title: "Release notes", participants: [] }); // conversation 52: "devtool" is not in it yet
  const row = async (event: string, reason: string, conversation: number, act: () => Promise<unknown>) => {
    // When <event>
    await act();
    // Then "convoz inbox --peek --sid s1" shows an item with reason "<reason>"
    const items = await peekAll(u);
    expect(items.map((i) => [i.reason, i.conversation.id]), event).toContainEqual([reason, conversation]);
    await drain(u);
  };

  await row('the owner posts "@devtool look" in conversation 41', "mention", conv, () => ownerSays(w.owner, conv, "@devtool look"));
  await row('the owner posts "next step?" in conversation 41', "activity", conv, () => ownerSays(w.owner, conv, "next step?"));
  await row('the owner replies in a thread that "devtool" started in conversation 41', "thread", conv, async () => {
    const root = await agentSays(w.srv, s1.lease, conv, "Step 1 is the filter chips UI");
    must(await w.owner.client.post(`/api/conversations/${conv}/messages`, { client_id: clientId(), body: "sounds right", thread_root_id: root }), "thread reply", 201);
  });
  await row('the owner answers an ask of "devtool"', "ask_resolved", conv, async () => {
    const id = await agentAsks(w.srv, s1.lease, conv);
    expect((await answerAsk(w.owner, id, { choice: "recommended" })).status).toBe(200);
  });
  await row('the owner dismisses an ask of "devtool"', "ask_resolved", conv, async () => {
    const id = await agentAsks(w.srv, s1.lease, conv, { question: "Ship it today?" });
    expect((await markAsk(w.owner, id, "dismiss")).status).toBe(200);
  });
  await row('the owner adds "devtool" to conversation 52', "membership", other, async () => {
    must(await w.owner.client.post(`/api/conversations/${other}/participants`, { handle: "devtool" }), "add devtool", 201);
  });
  await row('the owner declines an add that "devtool" requested in conversation 52', "membership", other, async () => {
    const asked = must(await send(w.srv.target, "POST", `/api/conversations/${other}/participants`, { json: { handle: "docs" }, ...bearer(s1.lease) }), "devtool requests the add", 201);
    const docs = asked.json().participant.identity_id as number;
    must(await w.owner.client.post(`/api/conversations/${other}/participants/${docs}/decline`, {}), "decline the add");
  });
  await row('the owner sends a result through an app of "devtool"', "app_result", conv, async () => {
    const app = await devtoolPostsApp(u);
    await drain(u); // the app message itself made no item for "devtool"; nothing else is waiting
    await ownerSendsResult(u, app);
  });
});

scenario("A voice message reaches the agent as words", { tag: ["@cli"] }, async ({ server, testApi }, info) => {
  info.setTimeout(60_000);
  const { w, conv, s1 } = await inboxWorld(server);

  // Given the transcription engine takes 30 seconds
  const who = { srv: w.srv, owner: w.owner };
  await scriptEngine(who, { text: "ship the filters on Thursday", delayMs: 30_000 });

  // When the owner sends a voice note that says "ship the filters on Thursday" in conversation 41
  await ownerSendsVoice(who, conv);
  await sleep(2_500); // the transcript worker takes a job within a second; from then on the engine counts the 30 seconds

  // Then "convoz inbox --wait 60 --sid s1" returns the item only after the transcript is done
  const waiting = w.box.start(["inbox", "--json", "--sid", s1.sid, "--wait", "60"], { timeoutMs: 45_000 });
  try {
    expect(await exitsWithin(waiting, 3_000), "the item came before the transcript was done").toBeNull();
    await testApi(w.srv).advanceClock(30_000); // the 30 seconds pass
    const done = await exitsWithin(waiting, 20_000);
    expect(done, "the item did not come after the transcript was done").not.toBeNull();
    const items = JSON.parse(done!.stdout).items as (Item & { transcript_state?: string; message: { text?: string; uploads?: { transcript?: { text?: string } }[] } })[];

    // And the item text is "ship the filters on Thursday"
    expect(items).toHaveLength(1);
    expect(items[0]!.transcript_state).toBe("done");
    expect(items[0]!.message.uploads?.[0]?.transcript?.text).toBe("ship the filters on Thursday");
    expect(items[0]!.message.text).toBe("Voice note 0:03: ship the filters on Thursday");
  } finally {
    waiting.stop();
  }
});

scenario("Answers, membership changes and app results stay separate items", { tag: ["@cli"] }, async ({ server }) => {
  const u = await inboxWorld(server);
  const { w, conv, s1 } = u;
  const app = await devtoolPostsApp(u);
  const ask = await agentAsks(w.srv, s1.lease, conv);

  // Given the owner posted 2 messages in conversation 41
  await ownerSays(w.owner, conv, "first");
  await ownerSays(w.owner, conv, "second");

  // When the owner answers an ask of "devtool" there and sends a result through an app of "devtool" there
  expect((await answerAsk(w.owner, ask, { choice: "recommended" })).status).toBe(200);
  await ownerSendsResult(u, app);

  // Then "convoz inbox --peek --sid s1" shows 3 items for conversation 41: the conversation item, one "ask_resolved" and one "app_result"
  const items = (await peekAll(u)).filter((i) => i.conversation.id === conv);
  expect(items.map((i) => i.reason).sort()).toEqual(["activity", "app_result", "ask_resolved"]);
  expect(items.find((i) => i.reason === "activity")!.count).toBe(2);
});

// ---- contracts/inbox.feature -----------------------------------------------------------------------------

scenario("A voice item waits at most 120 seconds for its transcript", { tag: ["@api"] }, async ({ server, testApi }, info) => {
  info.setTimeout(60_000);
  const { w, conv, s1, s2 } = await inboxWorld(server);
  const clock = testApi(w.srv);
  const who = { srv: w.srv, owner: w.owner };
  const claim = async (lease: string) => ((await inboxApi(w.srv, lease, "claim=5")).json().items as (Item & { transcript_state?: string })[]);

  // Given the transcription engine fails
  await scriptEngine(who, { text: "", fail: true });
  await clock.freezeClock(); // the test clock moves only when the scenario moves it, so "119 seconds" and "120 seconds" are exact

  // When the owner sends a voice note in conversation 41
  await ownerSendsVoice(who, conv);
  await sleep(2_500); // the first try has failed

  // Then no session can claim its item before 120 seconds pass on the test clock
  await clock.advanceClock(119_000);
  await sleep(1_500);
  expect(await claim(s1.lease)).toEqual([]);
  expect(await claim(s2.lease)).toEqual([]);

  // And after 120 seconds the item is delivered with transcript_state "failed"
  await clock.advanceClock(1_000);
  const delivered = await claim(s1.lease);
  expect(delivered.map((i) => [i.reason, i.conversation.id, i.transcript_state])).toEqual([["activity", conv, "failed"]]);
});
