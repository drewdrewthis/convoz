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

test("a question is done when the last word is an agent's, started when the owner wrote again", () => {
  const q = msg(1, "drew", "human", "Why is CI red?\nsecond line");
  const a = msg(2, "dev", "agent", "A flaky test.\nFixed.\nThird");
  assert.equal(questionsOf(1, "Chat", [q], "drew", NOW), null);
  const done = questionsOf(1, "Chat", [q, a], "drew", NOW);
  assert.equal(done?.state, "done");
  assert.equal(done?.title, "Your question: Why is CI red?");
  assert.equal(done?.context, "A flaky test. Fixed.");
  const again = questionsOf(1, "Chat", [q, a, msg(3, "drew", "human", "and?", { thread_root_id: 1 })], "drew", NOW);
  assert.equal(again?.state, "started");
});
