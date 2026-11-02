import assert from "node:assert/strict";
import { test } from "node:test";
import { parseWidth } from "./widthRange.ts";

test("a stored width that is not a number reads as the default", () => {
  assert.equal(parseWidth("abc"), 240);
  assert.equal(parseWidth(null), 240);
});

test("a stored width outside the range is clamped to it", () => {
  assert.equal(parseWidth("9999"), 480);
  assert.equal(parseWidth("100"), 200);
  assert.equal(parseWidth("320"), 320);
});
