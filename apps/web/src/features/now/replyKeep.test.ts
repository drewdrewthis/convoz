import assert from "node:assert/strict";
import { test } from "node:test";
import { sendReply } from "./replyView.ts";

// Owner report: a reply typed while the server restarted was gone. The box empties only once the server took the reply.

test("a reply the server did not take stays in the box", async () => {
  let cleared = 0;
  await sendReply("  on it  ", async () => false, () => void cleared++);
  assert.equal(cleared, 0);
});

test("a reply the server took empties the box, and goes out trimmed", async () => {
  const sent: string[] = [];
  let cleared = 0;
  await sendReply("  on it  ", async (t) => (sent.push(t), true), () => void cleared++);
  assert.deepEqual(sent, ["on it"]);
  assert.equal(cleared, 1);
});

test("an empty box sends nothing", async () => {
  let sends = 0;
  await sendReply("   ", async () => (sends++, true), () => {});
  assert.equal(sends, 0);
});
