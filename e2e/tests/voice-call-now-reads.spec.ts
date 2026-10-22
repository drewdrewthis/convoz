import { agentPost, agentSays, listConversations } from "../lib/chat.ts";
import { callWorld, fakeMic, KEY, onANowCall, voiceKey } from "../lib/call.ts";
import { must } from "../lib/owner.ts";
import { expect, scenario, test } from "../lib/scenario.ts";

/*
 * THE NOW CALL'S READS: specs/features/voice-call.feature, the rule on calling Now. Owner said (conv 115, a live call log): the triage
 * call "can't see messages". So it searches the messages, reads one conversation with its threads, and lists the conversations. The
 * fakes are those of voice-call-now.spec.ts; the page contract is the block atop lib/call.ts.
 */

test.use({ launchOptions: fakeMic });

const ISO_MINUTE = /^\d{4}-\d\d-\d\dT\d\d:\d\dZ$/;

scenario("The model searches the messages and the answer holds the hits", { tag: ["@browser"] }, async ({ server, page, context }) => {
  // Background
  const u = await callWorld({ server, page, context });
  await voiceKey(u.w, KEY);
  // Given "dot" posted "The hooks work is merged, next is the retry" in conversation 41
  const id = await agentSays(u.w.srv, u.dot.lease, u.conv, "The hooks work is merged, next is the retry");
  // And the owner is on a Now call
  const model = await onANowCall(page, u.w.srv);

  // When the model asks for search_messages with "hooks"
  model.call("search_messages", { query: "hooks" });

  // Then the answer to the model holds that message from "dot" in "Ship search filters", with its time and its message id
  await expect.poll(() => model.responses()).toHaveLength(1);
  const { hits } = model.responses()[0].response;
  expect(hits).toHaveLength(1);
  expect(hits[0]).toMatchObject({ conversation: "Ship search filters", conversation_id: u.conv, author: "dot", message_id: id });
  expect(hits[0].text).toContain("hooks work is merged");
  expect(hits[0].at).toMatch(ISO_MINUTE);
});

scenario("The model reads a conversation named by a part of its title, with its thread replies", { tag: ["@browser"] }, async ({ server, page, context }) => {
  // Background
  const u = await callWorld({ server, page, context });
  await voiceKey(u.w, KEY);
  // Given "dot" posted "Deploy is at 14:00" in conversation 41 and replied "Done at 14:02" in its thread
  const root = await agentSays(u.w.srv, u.dot.lease, u.conv, "Deploy is at 14:00");
  must(await agentPost(u.w.srv, u.dot.lease, u.conv, "Done at 14:02", { thread_root_id: root }), "dot replies in the thread", 201);
  // And "dot" posted a message of 3000 characters in conversation 41
  await agentSays(u.w.srv, u.dot.lease, u.conv, "long ".repeat(600));
  // And the owner is on a Now call
  const model = await onANowCall(page, u.w.srv);

  // When the model asks for read_conversation with the title "search filters"
  model.call("read_conversation", { title: "search filters" });

  // Then the answer to the model names conversation 41 "Ship search filters"
  await expect.poll(() => model.responses()).toHaveLength(1);
  const answer = model.responses()[0].response;
  expect(answer.conversation).toEqual({ id: u.conv, title: "Ship search filters" });

  // And it holds "Deploy is at 14:00" with the reply "Done at 14:02" under it
  const deploy = answer.messages.find((m: { text: string }) => m.text === "Deploy is at 14:00");
  expect(deploy).toMatchObject({ id: root, author: "dot", reply_count: 1, replies: [{ author: "dot", text: "Done at 14:02" }] });
  expect(deploy.at).toMatch(ISO_MINUTE);
  expect(answer.messages.filter((m: { text: string }) => m.text === "Done at 14:02")).toEqual([]);

  // And no message in it is longer than 300 characters
  expect(answer.messages).toHaveLength(2);
  for (const m of answer.messages) expect(m.text.length).toBeLessThanOrEqual(300);
  expect(answer.messages[1].text).toMatch(/^long long .*…$/);
});

scenario("The model lists the open conversations with their unread counts", { tag: ["@browser"] }, async ({ server, page, context }) => {
  // Background
  const u = await callWorld({ server, page, context });
  await voiceKey(u.w, KEY);
  // Given "dot" posted 2 messages in conversation 41 that the owner has not read
  await agentSays(u.w.srv, u.dot.lease, u.conv, "First update");
  await agentSays(u.w.srv, u.dot.lease, u.conv, "Second update");
  // And the owner is on a Now call
  const model = await onANowCall(page, u.w.srv);

  // When the model asks for list_conversations
  model.call("list_conversations", {});

  // Then the answer to the model lists "Ship search filters" with the unread count the server holds and its last activity
  await expect.poll(() => model.responses()).toHaveLength(1);
  const held = (await listConversations(u.w.owner)).find((c) => c.id === u.conv)!;
  expect(held.unread).toBeGreaterThanOrEqual(2);
  const row = model.responses()[0].response.conversations.find((c: { id: number }) => c.id === u.conv);
  expect(row).toEqual({ id: u.conv, title: "Ship search filters", unread: held.unread, last_activity: new Date(held.last_activity_at).toISOString().slice(0, 16) + "Z" });
});
