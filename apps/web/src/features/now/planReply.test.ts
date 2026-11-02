import assert from "node:assert/strict";
import { test } from "node:test";
import type { NowWaiting } from "@convoz/api-client";
import { planReply } from "./planReply.ts";

// Owner, 2026-10-30 (conv 179 msg 14202): Reply on a plan item "went to the conversation itself instead of the mini reply".
// A plan item has no message to reply under, so the reply is a message in its conversation that names the waiting agent.
const plan = {
  conversation: { id: 556, title: "Deploy ed3f89c" },
  agent: { handle: "cloud-tech", display_name: "Cloud tech", kind: "agent" },
  text: "signed-in look: an agent card lists its open items",
  since: 1,
} as NowWaiting;

test("a reply to a plan item is a message in its conversation that names the waiting agent", () => {
  assert.deepEqual(planReply(plan, "looks good"), { conversation: 556, body: "@cloud-tech looks good" });
});

test("the reply text is trimmed", () => {
  assert.deepEqual(planReply(plan, "  looks good \n"), { conversation: 556, body: "@cloud-tech looks good" });
});

test("an empty reply sends nothing", () => {
  assert.equal(planReply(plan, "  \n "), null);
});
