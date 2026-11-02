import assert from "node:assert/strict";
import { test } from "node:test";
import type { WaitingUnanswered } from "@convoz/api-client";
import { entries } from "./entries.ts";
import { UNANSWERED_LABEL, unansweredFrame } from "./unanswered.ts";

const u = (over: Partial<WaitingUnanswered>): WaitingUnanswered => ({ conversation: { id: 5, title: null }, message_id: 9, excerpt: "any news", created_at: 100, age_ms: 660000, members: ["alpha", "docs"], ...over });

test("unanswered entries sit in the one list, newest first", () => {
  const list = entries([{ id: 1, created_at: 300 } as never], [{ text: "p", since: 100 } as never], [], [], [u({ created_at: 200 })]);
  assert.deepEqual(list.map((e) => e.at), [300, 200, 100]);
  assert.ok("unanswered" in list[1]!);
});

test("the card says You asked, shows the excerpt, and links to the message", () => {
  const f = unansweredFrame(u({}), () => "");
  assert.equal(f.title, "You asked");
  assert.equal(f.context, "any news");
  assert.equal(f.href, "/chats/5#m9");
  assert.equal(f.from.id, 5);
});

test("a chat with no title falls back to the cached title, then to the member handles", () => {
  assert.equal(unansweredFrame(u({ conversation: { id: 5, title: "Launch" } }), () => "").from.title, "Launch");
  assert.equal(unansweredFrame(u({}), () => "Cached").from.title, "Cached");
  assert.equal(unansweredFrame(u({}), () => "").from.title, "@alpha @docs");
});

test("the card marker reads No reply yet", () => {
  assert.equal(UNANSWERED_LABEL, "No reply yet");
});
