import assert from "node:assert/strict";
import { test } from "node:test";
import type { MessageCreatedFrame } from "@convoz/api-client";
import { messageHref, messageLine } from "./messageToast.ts";

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
