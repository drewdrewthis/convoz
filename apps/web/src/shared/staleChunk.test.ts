import assert from "node:assert/strict";
import { test } from "node:test";
import { mayReload } from "./staleChunk.ts";

const store = (v: string | null) => ({ getItem: () => v, setItem: (_k: string, x: string) => void (v = x) });

test("the first failed chunk load may reload", () => {
  assert.equal(mayReload(store(null), 1_000_000), true);
});

test("a second reload within 60 seconds is refused", () => {
  assert.equal(mayReload(store("1000000"), 1_030_000), false);
});

test("a reload 60 seconds after the last one is allowed", () => {
  assert.equal(mayReload(store("1000000"), 1_060_000), true);
});
