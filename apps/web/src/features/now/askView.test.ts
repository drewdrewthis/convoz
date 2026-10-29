import assert from "node:assert/strict";
import { test } from "node:test";
import type { Ask } from "@convoz/api-client";
import { askFrame, okayAnswer } from "./askView.ts";

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
