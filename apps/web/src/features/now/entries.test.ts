import assert from "node:assert/strict";
import { test } from "node:test";
import type { Ask, NowWaiting } from "@convoz/api-client";
import type { Fyi } from "./feed.ts";
import { entries } from "./entries.ts";

test("entries lists asks and waiting plan items together, newest first", () => {
  const list = entries([{ id: 1, created_at: 100 } as Ask, { id: 2, created_at: 300 } as Ask], [{ text: "p", since: 200 } as NowWaiting]);
  assert.deepEqual(list.map((e) => e.at), [300, 200, 100]);
  assert.equal(entries([], [], [{ at: 5 } as Fyi]).length, 1);
});
