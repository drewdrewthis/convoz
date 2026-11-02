import assert from "node:assert/strict";
import { test } from "node:test";
import { pushOptions } from "./pushOptions.ts";

// Advisor before the PR 253 deploy: message pushes were too loud. A newer message push replaces the one still showing without a
// second ring (renotify false); other reasons keep what they did.
test("a message push replaces the one still showing without ringing again", () => {
  const o = pushOptions({ reason: "message", title: "Devtool @devtool", body: "3 new", url: "/chats/41", topic: "c41" });
  assert.equal(o.renotify, false);
  assert.equal(o.tag, "c41");
  assert.equal(o.body, "3 new");
  assert.deepEqual(o.data, { url: "/chats/41" });
});

test("other pushes keep what they did: no renotify set", () => {
  const o = pushOptions({ reason: "mention", body: "hi", url: "/chats/41", topic: "c41" });
  assert.equal("renotify" in o, false);
  assert.equal(o.tag, "c41");
});
