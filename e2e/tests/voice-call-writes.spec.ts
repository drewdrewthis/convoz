import { askOf, agentAsks, QUESTION } from "../lib/asks.ts";
import { agentSays, ownerSays } from "../lib/chat.ts";
import { messageLog } from "../lib/chat-ui.ts";
import { callStatus, callWorld, fakeMic, KEY, onANowCall, openConversation, ownerPosts, voiceKey, voicePosts, type CallWorld, type FakeModel, type Post } from "../lib/call.ts";
import { must } from "../lib/owner.ts";
import { expect, scenario, test } from "../lib/scenario.ts";

/*
 * THE NOW CALL'S WRITES: specs/features/voice-call.feature, the rule on calling Now (phase 2 of convoz#43). Owner: "manage my whole
 * Convoz by voice". A write the model asks for does nothing at once: it is read back and held; confirm_action after the owner's yes
 * runs it once; cancel_action or a new write drops it. The fakes are those of voice-call-now.spec.ts; the page contract is atop lib/call.ts.
 */

test.use({ launchOptions: fakeMic });

const NOTHING_WAITS = { error: "nothing waits for a yes" };

/** The owner speaks (no words: he says nothing new), then the model calls a tool; resolves with the call's answer to it. */
async function ownerThen(model: FakeModel, words: string, name: string, args: Record<string, unknown> = {}): Promise<any> {
  const before = model.responses().length;
  if (words) model.hear(words);
  model.call(name, args);
  await expect.poll(() => model.responses().length).toBe(before + 1);
  return model.responses()[before].response;
}

/** The replies in the thread of one message, as the server holds them. */
async function repliesOf(u: CallWorld, root: number): Promise<Post[]> {
  return must(await u.w.owner.client.get(`/api/messages/${root}/replies`), "read the thread").json().messages;
}

/** Whether the server holds conversation `conv` as stale. */
async function isStale(u: CallWorld, conv: number): Promise<boolean> {
  const rows = must(await u.w.owner.client.get("/api/conversations"), "list conversations").json().conversations as { id: number; stale?: boolean }[];
  return rows.find((c) => c.id === conv)?.stale === true;
}

scenario("The model posts in a conversation only after the owner says yes", { tag: ["@browser"] }, async ({ server, page, context }) => {
  // Background
  const u = await callWorld({ server, page, context });
  await voiceKey(u.w, KEY);
  // Given the owner is on a Now call
  const model = await onANowCall(page, u.w.srv);

  // When the owner says "post ship it in search filters" and the model asks for post_message with "Ship it" in "search filters"
  const planned = await ownerThen(model, "post ship it in search filters", "post_message", { title: "search filters", text: "Ship it" });

  // Then the answer to the model reads back "I will post "Ship it" in Ship search filters. Say yes to send."
  expect(planned).toMatchObject({ pending: true, read_back: 'I will post "Ship it" in Ship search filters. Say yes to send.' });

  // And @voice has posted nothing in conversation 41
  expect(await voicePosts(u.w, u.conv)).toEqual([]);

  // When the owner says "yes" and the model asks for confirm_action
  expect(await ownerThen(model, "yes", "confirm_action")).toEqual({ done: "Posted in Ship search filters." });

  // Then @voice's message "Ship it" is in conversation 41
  await expect.poll(() => voicePosts(u.w, u.conv)).toEqual([expect.objectContaining({ body: "Ship it" })]);

  // When the model asks for confirm_action again
  // Then the answer to the model says nothing waits for a yes
  expect(await ownerThen(model, "", "confirm_action")).toEqual(NOTHING_WAITS);

  // And conversation 41 holds @voice's "Ship it" once
  expect((await voicePosts(u.w, u.conv)).filter((m) => m.body === "Ship it")).toHaveLength(1);
});

scenario("The model replies in a thread only after the owner says yes", { tag: ["@browser"] }, async ({ server, page, context }) => {
  // Background
  const u = await callWorld({ server, page, context });
  await voiceKey(u.w, KEY);
  // Given "dot" posted "Deploy is at 14:00" in conversation 41
  const root = await agentSays(u.w.srv, u.dot.lease, u.conv, "Deploy is at 14:00");
  // And the owner is on a Now call
  const model = await onANowCall(page, u.w.srv);

  // When the owner says "reply thanks" and the model asks for reply_in_thread on that message with "Thanks"
  const planned = await ownerThen(model, "reply thanks", "reply_in_thread", { message_id: root, text: "Thanks" });

  // Then the answer to the model reads back the reply "Thanks", the message "Deploy is at 14:00" from "dot" and "Ship search filters"
  expect(planned.read_back).toBe('I will reply "Thanks" to @dot\'s message "Deploy is at 14:00" in Ship search filters. Say yes to send.');

  // And the thread of that message has no reply
  expect(await repliesOf(u, root)).toEqual([]);

  // When the owner says "yes" and the model asks for confirm_action
  expect(await ownerThen(model, "yes", "confirm_action")).toEqual({ done: "Replied in Ship search filters." });

  // Then the thread of that message holds @voice's reply "Thanks"
  await expect.poll(() => repliesOf(u, root)).toEqual([expect.objectContaining({ author: expect.objectContaining({ handle: "voice", kind: "agent" }), body: "Thanks" })]);
  expect((await repliesOf(u, root))[0]!.via_voice).toBeUndefined();
});

scenario("Cancel drops a write the owner has not said yes to", { tag: ["@browser"] }, async ({ server, page, context }) => {
  // Background
  const u = await callWorld({ server, page, context });
  await voiceKey(u.w, KEY);
  // Given "dot" posted "Deploy is at 14:00" in conversation 41
  const root = await agentSays(u.w.srv, u.dot.lease, u.conv, "Deploy is at 14:00");
  // And the owner is on a Now call
  const model = await onANowCall(page, u.w.srv);

  // When the owner says "reply thanks" and the model asks for reply_in_thread on that message with "Thanks"
  expect(await ownerThen(model, "reply thanks", "reply_in_thread", { message_id: root, text: "Thanks" })).toMatchObject({ pending: true });

  // And the owner says "no" and the model asks for cancel_action
  expect(await ownerThen(model, "no", "cancel_action")).toEqual({ cancelled: true });

  // And the model asks for confirm_action
  // Then the answer to the model says nothing waits for a yes
  expect(await ownerThen(model, "", "confirm_action")).toEqual(NOTHING_WAITS);

  // And the thread of that message has no reply
  expect(await repliesOf(u, root)).toEqual([]);
});

scenario("The model answers an ask only after the owner says yes, and a new write drops the one before", { tag: ["@browser"] }, async ({ server, page, context }) => {
  // Background
  const u = await callWorld({ server, page, context });
  await voiceKey(u.w, KEY);
  // Given "dot" asked "Merge #415 on its own?" in conversation 41, with "Merge it" recommended and "Hold it" the alternative
  const ask = await agentAsks(u.w.srv, u.dot.lease, u.conv);
  // And the owner is on a Now call
  const model = await onANowCall(page, u.w.srv);

  // When the owner says "merge it" and the model asks for answer_ask on that ask with option 1
  const planned = await ownerThen(model, "merge it", "answer_ask", { ask_id: ask, option: 1 });

  // Then the answer to the model reads back "Merge #415 on its own?", "Ship search filters" and "Merge it"
  expect(planned.read_back).toBe(`I will answer @dot's ask "${QUESTION}" in Ship search filters with "Merge it". Say yes to send.`);

  // And the ask is still open
  expect((await askOf(u.w.owner, ask)).state).toBe("open");

  // When the owner says "no, hold it" and the model asks for answer_ask on that ask with option 2
  expect(await ownerThen(model, "no, hold it", "answer_ask", { ask_id: ask, option: 2 })).toMatchObject({ pending: true, read_back: expect.stringContaining('with "Hold it"') });

  // And the owner says "yes" and the model asks for confirm_action
  expect(await ownerThen(model, "yes", "confirm_action")).toEqual({ done: "Answered in Ship search filters." });

  // Then the ask is answered with "Hold it"
  expect(await askOf(u.w.owner, ask)).toMatchObject({ state: "answered", chosen: { kind: "alternative", index: 1 }, answer: "Hold it" });
});

scenario("The model marks a conversation stale only after the owner says yes", { tag: ["@browser"] }, async ({ server, page, context }) => {
  // Background
  const u = await callWorld({ server, page, context });
  await voiceKey(u.w, KEY);
  // Given "dot" posted "Shipped, nothing left" in conversation 41
  await agentSays(u.w.srv, u.dot.lease, u.conv, "Shipped, nothing left");
  // And the owner is on a Now call
  const model = await onANowCall(page, u.w.srv);

  // When the owner says "search filters is done" and the model asks for mark_stale on "search filters"
  const planned = await ownerThen(model, "search filters is done", "mark_stale", { title: "search filters" });

  // Then the answer to the model reads back "I will mark Ship search filters stale. Say yes to mark it."
  expect(planned).toMatchObject({ pending: true, read_back: "I will mark Ship search filters stale. Say yes to mark it." });

  // And conversation 41 is not stale
  expect(await isStale(u, u.conv)).toBe(false);

  // When the owner says "yes" and the model asks for confirm_action
  expect(await ownerThen(model, "yes", "confirm_action")).toEqual({ done: "Ship search filters is stale." });

  // Then conversation 41 is stale
  expect(await isStale(u, u.conv)).toBe(true);
});

scenario("A write the server refuses comes back as a short sentence", { tag: ["@browser"] }, async ({ server, page, context }) => {
  // Background
  const u = await callWorld({ server, page, context });
  await voiceKey(u.w, KEY);
  // Given the owner wrote the last message in conversation 41
  await agentSays(u.w.srv, u.dot.lease, u.conv, "Shipped, nothing left");
  await ownerSays(u.w.owner, u.conv, "One more thing");
  // And the owner is on a Now call
  const model = await onANowCall(page, u.w.srv);

  // When the owner says "search filters is done" and the model asks for mark_stale on "search filters"
  expect(await ownerThen(model, "search filters is done", "mark_stale", { title: "search filters" })).toMatchObject({ pending: true });

  // And the owner says "yes" and the model asks for confirm_action
  const answer = await ownerThen(model, "yes", "confirm_action");

  // Then the answer to the model is the error "You wrote the last message there, so it cannot go stale."
  expect(answer).toEqual({ error: "You wrote the last message there, so it cannot go stale." });

  // And conversation 41 is not stale and the call is still live
  expect(await isStale(u, u.conv)).toBe(false);
  await expect(callStatus(page)).toHaveText("Live");
  expect(model.closed()).toBe(false);
});

scenario("A message the call sends comes from @voice, not the owner", { tag: ["@browser"] }, async ({ server, page, context }) => {
  // Background
  const u = await callWorld({ server, page, context });
  await voiceKey(u.w, KEY);
  // Given the owner is on a Now call
  const model = await onANowCall(page, u.w.srv);

  // When the owner says "post ship it in search filters" and the model asks for post_message with "Ship it" in "search filters"
  expect(await ownerThen(model, "post ship it in search filters", "post_message", { title: "search filters", text: "Ship it" })).toMatchObject({ pending: true });

  // And the owner says "yes" and the model asks for confirm_action
  expect(await ownerThen(model, "yes", "confirm_action")).toEqual({ done: "Posted in Ship search filters." });

  // Then conversation 41 shows "Ship it" from "Voice" @voice, with no "via voice call" mark
  await openConversation(page, u.w.srv, u.conv);
  const posted = messageLog(page).getByRole("article").filter({ hasText: "Ship it" });
  await expect(posted).toBeVisible();
  await expect(posted.locator(".author")).toHaveText("Voice @voice");
  await expect(posted.getByText("via voice call")).toHaveCount(0);

  // And the server holds "Ship it" from the agent "voice", and the owner has posted nothing in conversation 41
  expect(await voicePosts(u.w, u.conv)).toEqual([expect.objectContaining({ body: "Ship it", author: expect.objectContaining({ handle: "voice", display_name: "Voice", kind: "agent" }) })]);
  expect((await voicePosts(u.w, u.conv))[0]!.via_voice).toBeUndefined();
  expect(await ownerPosts(u.w, u.conv)).toEqual([]);
});
