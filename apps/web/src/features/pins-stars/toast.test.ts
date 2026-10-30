import assert from "node:assert/strict";
import { afterEach, beforeEach, mock, test } from "node:test";
import { notify, runUndo, toast, useToast } from "./toast.ts";

// Advisor on PR 249: a message toast replaced a live Undo (unpin, unstar, delete) within its 10 s, so the Undo was lost.
// News (a message, an ask, a connect request) waits while an Undo shows, and shows once the Undo is gone.
beforeEach(() => mock.timers.enable({ apis: ["setTimeout"] }));
afterEach(() => {
  mock.timers.tick(60_000);
  mock.timers.reset();
});

const text = () => useToast.getState().text;

test("news does not replace a live Undo toast; it shows when the Undo toast ends", () => {
  toast("Unpinned", () => {});
  notify("@devtool in Ship: done");
  assert.equal(text(), "Unpinned");
  mock.timers.tick(10_000);
  assert.equal(text(), "@devtool in Ship: done");
  assert.equal(useToast.getState().label, "Undo");
});

test("news held behind an Undo shows at once when the Undo is used, with its own button", () => {
  const open = mock.fn();
  toast("Unstarred", () => {});
  notify("@devtool in Ship: done", open, "Open");
  runUndo();
  assert.equal(text(), "@devtool in Ship: done");
  assert.equal(useToast.getState().label, "Open");
  useToast.getState().undo?.();
  assert.equal(open.mock.callCount(), 1);
});

test("the newest news waits, not each one", () => {
  toast("Deleted", () => {});
  notify("first");
  notify("second");
  mock.timers.tick(10_000);
  assert.equal(text(), "second");
  mock.timers.tick(10_000);
  assert.equal(text(), "");
});

test("news with no Undo showing shows at once, in place of a plain toast", () => {
  toast("Link copied");
  notify("@devtool in Ship: done");
  assert.equal(text(), "@devtool in Ship: done");
});
