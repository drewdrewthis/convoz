import assert from "node:assert/strict";
import { test } from "node:test";
import { NOW_ORDER } from "./order.ts";

// Every block DevNow draws today but the notes, which stay fixed at the top; a section dropped from the order would vanish from Now.
const DRAWN = ["allClear", "noDecisions", "folds", "needs", "adds", "joined", "requests", "overdue", "mentions", "replies", "replied", "other"];

test("machine requests are the first section of Now (owner: they block an agent until approved)", () => {
  assert.equal(NOW_ORDER[0], "requests");
});

test("the joined cards come right after the requests that made them", () => {
  assert.equal(NOW_ORDER[1], "joined");
});

test("every section DevNow draws is in the order exactly once", () => {
  assert.deepEqual([...NOW_ORDER].sort(), [...DRAWN].sort());
});
