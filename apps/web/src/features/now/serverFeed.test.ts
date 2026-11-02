import assert from "node:assert/strict";
import { test } from "node:test";
import type { FeedItem } from "@convoz/api-client";
import { itemsOrEmpty, nextOf, shown } from "./entries.ts";

const item = (o: Partial<FeedItem>) => ({ id: 1, conversation_id: 1, agent_id: 1, seq: 1, state: "started", title: "t", version: 1, updated_at: 1, can_accept: false, key: "k", ...o }) as FeedItem;

test("shown hides pending, snoozed and acknowledged items", () => {
  const list = [item({ id: 1 }), item({ id: 2, state: "pending" }), item({ id: 3, snoozed_until: 200 }), item({ id: 4, state: "fyi", acked_at: 5 }), item({ id: 5, snoozed_until: 50 })];
  assert.deepEqual(shown(list, 100).map((i) => i.id), [1, 5]);
});

test("nextOf lists the pending steps of the same agent and conversation in plan order", () => {
  const now = item({ id: 1 });
  const list = [now, item({ id: 3, state: "pending", seq: 3, title: "C" }), item({ id: 2, state: "pending", seq: 2, title: "B" }), item({ id: 4, state: "pending", agent_id: 9, title: "X" })];
  assert.deepEqual(nextOf(list, now), ["B", "C"]);
});

test("a 404 or a 403 on the feed is an empty list, and a good answer is its items", async () => {
  assert.deepEqual(await itemsOrEmpty(Promise.reject(new Error("404"))), []);
  assert.deepEqual(await itemsOrEmpty(Promise.reject(new Error("403"))), []);
  assert.equal((await itemsOrEmpty(Promise.resolve({ items: [item({})] }))).length, 1);
});
