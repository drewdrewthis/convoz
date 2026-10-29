import assert from "node:assert/strict";
import { test } from "node:test";
import type { Fyi } from "./feed.ts";
import { okayMark, snoozeMark, unseen } from "./seen.ts";

const f = (key: string, at: number) => ({ key, at }) as Fyi;

test("a card the owner okayed stays hidden until it moves", () => {
  const marks = okayMark({}, "q1", 100);
  assert.deepEqual(unseen([f("q1", 100), f("q2", 50)], marks, 200).map((x) => x.key), ["q2"]);
  assert.deepEqual(unseen([f("q1", 100)], marks, 200).length, 0);
  assert.deepEqual(unseen([f("q1", 150)], marks, 200).map((x) => x.key), ["q1"]);
});

test("a snoozed card is hidden until its time, then comes back", () => {
  const marks = snoozeMark({}, "q1", 500);
  assert.equal(unseen([f("q1", 100)], marks, 400).length, 0);
  assert.equal(unseen([f("q1", 100)], marks, 500).length, 1);
});

test("a snoozed card that moves comes back at once", () => {
  const marks = snoozeMark({}, "q1", 500);
  assert.equal(unseen([f("q1", 450)], marks, 400).length, 0);
  assert.equal(unseen([f("q1", 450)], { q1: { snoozeUntil: 500, seenAt: 300 } }, 400).length, 1);
});

test("an okay and a snooze on one card keep both marks", () => {
  const marks = snoozeMark(okayMark({}, "q1", 100), "q1", 900);
  assert.deepEqual(marks.q1, { okAt: 100, snoozeUntil: 900, seenAt: 0 });
});
