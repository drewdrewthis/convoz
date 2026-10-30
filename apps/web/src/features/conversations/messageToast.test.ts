import assert from "node:assert/strict";
import { mock, test } from "node:test";
import type { MessageCreatedFrame } from "@convoz/api-client";
import { batch, messageHref, messageLine } from "./messageToast.ts";

// Owner, 2026-10-30 (conv 179 msg 14167): "can I get a toast for every message?"
const msg = (o: Partial<MessageCreatedFrame> & { handle?: string; who?: "human" | "agent" | "system" } = {}) =>
  ({
    id: 501,
    conversation_id: 41,
    body: "Merged #415, the build is green.",
    author: { handle: o.handle ?? "devtool", display_name: "Devtool", kind: o.who ?? "agent" },
    author_handle: o.handle ?? "devtool",
    ...o,
  }) as MessageCreatedFrame;
const at = { me: "drew", open: null, title: "Ship search filters" };

test("a new message from someone else toasts who, where and what", () => {
  assert.equal(messageLine(msg(), at), "@devtool in Ship search filters: Merged #415, the build is green.");
});

test("the owner's own message toasts nothing", () => {
  assert.equal(messageLine(msg({ handle: "drew", who: "human" }), at), null);
});

test("a message in the conversation open on screen toasts nothing: the owner sees it already", () => {
  assert.equal(messageLine(msg(), { ...at, open: 41 }), null);
  assert.equal(messageLine(msg(), { ...at, open: 7 }), "@devtool in Ship search filters: Merged #415, the build is green.");
});

// Mute means quiet: a muted conversation makes no toast.
test("a message in a muted conversation toasts nothing", () => {
  assert.equal(messageLine(msg(), { ...at, muted: true }), null);
  assert.equal(messageLine(msg(), { ...at, muted: false }), "@devtool in Ship search filters: Merged #415, the build is green.");
});

// An ask is a message too; the Now arrival toast ("@x asks: ...") already tells of it, so it gets one toast, not two.
test("an ask message toasts nothing here", () => {
  assert.equal(messageLine(msg({ kind: "ask" }), at), null);
});

test("a system line (someone added, renamed, a plan changed) toasts nothing", () => {
  assert.equal(messageLine(msg({ kind: "system", handle: "system", who: "system" }), at), null);
});

test("only the first line shows, cut to 60 characters", () => {
  const long = `${"a".repeat(70)}\nsecond line`;
  assert.equal(messageLine(msg({ body: long }), at), `@devtool in Ship search filters: ${"a".repeat(59)}…`);
  assert.equal(messageLine(msg({ body: "\n\nDone.\nDetails below" }), at), "@devtool in Ship search filters: Done.");
});

test("a conversation with no title known names the author alone", () => {
  assert.equal(messageLine(msg(), { ...at, title: undefined }), "@devtool: Merged #415, the build is green.");
});

test("the toast opens that message in its conversation", () => {
  assert.equal(messageHref(msg()), "/chats/41#m501");
});

// Several messages at once (a busy agent, the catch-up after a gap in the stream) share one toast instead of each replacing the last.
test("what arrives within one second is handed over together, once", () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const out: string[][] = [];
    const add = batch<string>(1000, (items) => out.push(items));
    add("a");
    mock.timers.tick(400);
    add("b");
    assert.deepEqual(out, []);
    mock.timers.tick(600);
    assert.deepEqual(out, [["a", "b"]]);
    add("c");
    mock.timers.tick(1000);
    assert.deepEqual(out, [["a", "b"], ["c"]]);
  } finally {
    mock.timers.reset();
  }
});

// The window opens with the first item and does not restart: a steady stream still toasts every second.
test("a steady stream is handed over every second, not held back", () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const out: number[][] = [];
    const add = batch<number>(1000, (items) => out.push(items));
    for (let i = 0; i < 4; i++) {
      add(i);
      mock.timers.tick(500);
    }
    assert.deepEqual(out, [[0, 1], [2, 3]]);
  } finally {
    mock.timers.reset();
  }
});
