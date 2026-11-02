import assert from "node:assert/strict";
import { test } from "node:test";
import type { Message, PlanBoard } from "@convoz/api-client";
import { planItems, questionsOf } from "./feed.ts";

const NOW = new Date(2026, 5, 10, 15).getTime();
const msg = (id: number, handle: string, kind: "human" | "agent", body: string, extra: Partial<Message> = {}) =>
  ({ id, body, created_at: NOW - 1000 + id, author: { handle, display_name: handle, kind }, ...extra }) as Message;

test("the first Now line is the item and the rest show as Next", () => {
  const board = { now: NOW, plans: [{ conversation_id: 1, handle: "dev", now: [{ text: "A", since: NOW - 5 }, { text: "B" }], next: ["C"], done: [], doing_since: NOW - 5 }] } as unknown as PlanBoard;
  const [item] = planItems(board, () => "Chat");
  assert.equal(item?.title, "A");
  assert.deepEqual(item?.next, ["B", "C"]);
});

test("a step in Now and in Done shows its latest state", () => {
  const board = { now: NOW, plans: [{ conversation_id: 1, handle: "dev", now: [{ text: "A", since: NOW - 50 }], next: [], done: [{ text: "A", at: NOW - 5 }] }] } as unknown as PlanBoard;
  const items = planItems(board, () => "Chat");
  assert.equal(items.length, 1);
  assert.equal(items[0]?.state, "done");
});

test("a question is done when the last word is an agent's", () => {
  const q = msg(1, "drew", "human", "Why is CI red?\nsecond line");
  const a = msg(2, "dev", "agent", "A flaky test.\nFixed.\nThird");
  assert.equal(questionsOf(1, "Chat", [q], "drew", NOW), null);
  const done = questionsOf(1, "Chat", [q, a], "drew", NOW);
  assert.equal(done?.state, "done");
  assert.equal(done?.title, "Your question: Why is CI red?");
  assert.equal(done?.context, "A flaky test. Fixed.");
  assert.equal(questionsOf(1, "Chat", [q, a, msg(3, "drew", "human", "and?", { thread_root_id: 1 })], "drew", NOW), null);
});

const ask = (id: number, handle: string, kind: "human" | "agent", body: string, extra: Partial<Message> = {}) => msg(id, handle, kind, body, extra);

test("a bare reply word is no question", () => {
  for (const w of ["Go", " okay ", "OK.", "Yes!", "no", "Not this", "Snooze"]) {
    const list = [msg(1, "drew", "human", w), msg(2, "dev", "agent", "Done.")];
    assert.equal(questionsOf(1, "Chat", list, "drew", NOW), null, w);
  }
});

test("the answer text of an ask is no question", () => {
  const list = [ask(1, "dev", "agent", "Ship?", { kind: "ask", ask: { state: "answered", answer: "Ship it now, please" } as never }), msg(2, "drew", "human", "Ship it now, please"), msg(3, "dev", "agent", "Shipped.")];
  assert.equal(questionsOf(1, "Chat", list, "drew", NOW), null);
});

test("the owner's reply in the thread after the agent hides the card, an agent's later post brings it back", () => {
  const q = msg(1, "drew", "human", "Why is CI red?");
  const a = msg(2, "dev", "agent", "A flaky test.");
  const r = msg(3, "drew", "human", "ok rerun it", { thread_root_id: 1 });
  assert.equal(questionsOf(1, "Chat", [q, a, r], "drew", NOW), null);
  const back = questionsOf(1, "Chat", [q, a, r, msg(4, "dev", "agent", "Rerun green.", { thread_root_id: 1 })], "drew", NOW);
  assert.equal(back?.state, "done");
  assert.equal(back?.context, "Rerun green.");
});
