import assert from "node:assert/strict";
import { test } from "node:test";
import type { FeedItem } from "@convoz/api-client";
import { staleLine } from "./stale.ts";

const MIN = 60_000;
const at = new Date(2026, 0, 5, 9, 5).getTime();
const item = (state: string, updated_at: number) => ({ state, updated_at }) as unknown as FeedItem;

test("a started item with no update for 15 minutes shows the time of its last update", () => {
  assert.equal(staleLine(item("started", at), at + 15 * MIN), `No update since ${new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`);
});

test("a started item younger than 15 minutes shows no mark", () => {
  assert.equal(staleLine(item("started", at), at + 15 * MIN - 1), "");
});

test("blocking, done and pending items never show the mark", () => {
  for (const s of ["blocking", "done", "pending"]) assert.equal(staleLine(item(s, at), at + 99 * MIN), "");
});
