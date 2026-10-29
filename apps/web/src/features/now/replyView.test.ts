import assert from "node:assert/strict";
import { test } from "node:test";
import { boxShows, partsOf, takeRequest, type ThreadState } from "./replyView.ts";

const start = (o: Partial<ThreadState>): ThreadState => ({ count: 0, request: 0, seen: 0, open: false, writing: false, ...o });
const press = (s: ThreadState): ThreadState => takeRequest({ ...s, request: s.request + 1 });

// One case per kind of item. After Reply is pressed, the box shows (and takes the focus as it mounts).
const kinds: [string, Partial<ThreadState>][] = [
  ["an ask with no replies", { count: 0 }],
  ["an ask with replies", { count: 3 }],
  ["a server item with a root and no replies", { count: 0 }],
  ["a server item with a root and replies", { count: 2 }],
  ["an fyi with a root", { count: 1 }],
  ["an answered question", { count: 1 }],
];

for (const [name, o] of kinds) {
  test(`${name}: it starts collapsed, and Reply opens the reply box`, () => {
    const before = partsOf(start(o));
    assert.equal(before.box, false);
    assert.equal(before.replies, false);
    assert.equal(before.summary, (o.count ?? 0) > 0, "a summary only when there are replies");
    const after = partsOf(press(start(o)));
    assert.equal(after.box, true);
  });
}

test("an item with no replies and no Reply press draws nothing", () => {
  assert.deepEqual(partsOf(start({})), { summary: false, replies: false, box: false, replyHere: false });
});

test("a server item with no root: its empty box is hidden until Reply, then shown", () => {
  assert.equal(boxShows(0), false);
  assert.equal(boxShows(1), true);
  assert.equal(boxShows(2), true);
});

test("pressing Reply twice leaves the box open, and a second press after closing opens it again", () => {
  const once = press(start({ count: 2 }));
  const twice = press(once);
  assert.equal(partsOf(twice).box, true);
  const closed = { ...twice, open: false };
  assert.equal(partsOf(press(closed)).box, true);
});

test("the same request is not taken twice (a re-render does not reopen a closed thread)", () => {
  const taken = press(start({ count: 2 }));
  const closed = { ...taken, open: false, writing: false };
  assert.deepEqual(takeRequest(closed), closed);
});

test("an open thread with its box closed offers Reply here", () => {
  const s = start({ count: 2, request: 1, seen: 1, open: true, writing: false });
  assert.equal(partsOf(s).replyHere, true);
  assert.equal(partsOf(s).box, false);
});
