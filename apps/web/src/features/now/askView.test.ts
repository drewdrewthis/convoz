import assert from "node:assert/strict";
import { test } from "node:test";
import type { Ask } from "@convoz/api-client";
import { askFrame, carriesApp, doneLine, okayAnswer, openReply } from "./askView.ts";

// Every ask is one item (owner, conv 179 msg 11603, 12807, 12813): the action is the title; risk, undo and the other ways are the context.
const base = { question: "Merge PR 12?", options: [{ label: "Yes", why: "CI is green" }], asker: { handle: "devtool", display_name: "Devtool" }, answers: "" } as unknown as Ask;
const perm = {
  ...base,
  question: "Do you OK this?",
  permission: { action: "Merge PR 12 into main", risk: "A bad merge blocks the release", undo: "Revert the commit", considered: ["Wait a day: slower"], confidence: 80 },
} as unknown as Ask;

test("a permission ask: the action is the title and risk, undo and considered are the context", () => {
  const f = askFrame(perm, "@devtool");
  assert.equal(f.title, "Merge PR 12 into main");
  for (const part of ["Risk: A bad merge blocks the release", "Undo: Revert the commit", "Considered: Wait a day: slower"]) assert.ok(f.context.includes(part), part);
  assert.ok(!f.context.includes("I will"));
});

test("a one-way permission ask says so instead of an undo", () => {
  const f = askFrame({ ...perm, permission: { ...(perm as any).permission, undo: undefined, one_way: true } } as Ask, "@devtool");
  assert.ok(f.context.includes("Undo: None. This is one-way."));
});

test("a decision ask keeps its question as the title and its recommendation as the context", () => {
  const f = askFrame(base, "@devtool");
  assert.equal(f.title, "Merge PR 12?");
  assert.ok(f.context.includes("Recommended: Yes") && f.context.includes("CI is green"));
});

test("a draft ask is an item too: the question is the title and the draft is the context, labelled", () => {
  const draft = { ...base, question: "Send this to Alex?", draft: { text: "Thanks, Friday works." } } as unknown as Ask;
  const f = askFrame(draft, "@devtool");
  assert.equal(f.title, "Send this to Alex?");
  assert.ok(f.context.includes("Draft: Thanks, Friday works."));
  assert.ok(!f.context.includes("Recommended"));
});

test("Okay on a draft sends it as written", () => {
  const draft = { ...base, draft: { text: "Thanks, Friday works." } } as unknown as Ask;
  assert.deepEqual(okayAnswer(draft), { choice: "recommended", text: "Thanks, Friday works." });
  assert.deepEqual(okayAnswer(base), { choice: "recommended" });
});

test("an ask that carries an app shows it in the item, whatever its kind", () => {
  const app = { kind: "form" };
  for (const a of [base, perm, { ...base, draft: { text: "x" } }]) assert.equal(carriesApp({ ...a, app } as unknown as Ask), true);
  assert.equal(carriesApp(base), false);
});

const shut = (o: object) => ({ ...perm, ...o }) as unknown as Ask;

test("a closed ask is one line: who said what, Dismissed or Closed", () => {
  assert.equal(doneLine(shut({ state: "answered", chosen: { kind: "recommended" }, answer: "Yes", resolved_by: { handle: "drew" } })), "Go, by drew");
  assert.equal(doneLine(shut({ state: "answered", chosen: { kind: "alternative" }, answer: "Not this", resolved_by: { handle: "drew" } })), "Not this, by drew");
  assert.equal(doneLine({ ...base, state: "answered", chosen: { kind: "recommended" }, answer: "Yes", resolved_by: { handle: "drew" } } as unknown as Ask), "Yes, by drew");
  assert.equal(doneLine(shut({ state: "dismissed" })), "Dismissed");
  assert.equal(doneLine(shut({ state: "closed", close_reason: "withdrawn" })), "Closed");
  assert.equal(doneLine(shut({ state: "open" })), "");
});

// Reply on an ask (owner, conv 179 msg 13541): the card in the details panel's "Waiting on you" has no thread under it, and its root can be far
// back in the chat, out of the loaded list. Reply follows the #reply=<root> link, which the conversation page follows by loading back to the
// root, scrolling to it and opening its reply box (Conversation.tsx), as Now's "Reply in thread" does.
const page = (hash = "") => {
  const fired: string[] = [];
  return { fired, location: { hash }, dispatchEvent: (e: Event) => (fired.push(e.type), true) };
};

test("Reply on an ask opens its thread through the #reply link", () => {
  const w = page();
  openReply({ ...perm, id: 10724, thread_root_id: null } as unknown as Ask, w);
  assert.equal(w.location.hash, "#reply=10724");
});

test("Reply on an ask inside a thread opens that thread", () => {
  const w = page();
  openReply({ ...perm, id: 12, thread_root_id: 7 } as unknown as Ask, w);
  assert.equal(w.location.hash, "#reply=7");
});

test("Reply pressed again with the link already open is followed again", () => {
  const w = page("#reply=10724");
  openReply({ ...perm, id: 10724, thread_root_id: null } as unknown as Ask, w);
  assert.deepEqual(w.fired, ["hashchange"], "the same hash fires no hashchange by itself");
});
