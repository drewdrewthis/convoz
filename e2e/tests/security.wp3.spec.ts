import { convoz } from "../lib/chat.ts";
import { expect, scenario } from "../lib/scenario.ts";
import { must } from "../lib/owner.ts";
import { agentCreates, handlesOf, idsOf, startSession, viewOf, world } from "../lib/wp3.ts";

// WP3's part of security.feature (AC-26): an agent gets into a conversation only through a human. Pickup was removed.
// Owner said: "Nothing claims conversations. I need to tag." The routes are listed at the top of tests/conversations.wp3.spec.ts.

scenario("People an agent lists in a new conversation are pending", { tag: ["@api"] }, async ({ server }) => {
  // Background: "docs" is on "box-2" too
  const w = await world(server);
  const ids = await idsOf(w.owner);
  const dev = await startSession(w.box, "devtool", "devtool");
  const docs = await startSession(w.box, "docs", "docs");

  // When "devtool" creates a conversation listing "@docs"
  const made = must(await agentCreates(w.srv, dev.lease, { title: "Release prep", participants: ["docs"] }), "agent creates", 201);
  const conv = made.json().conversation.id as number;

  // Then "docs" is listed as pending
  const view = await viewOf(w.owner, conv);
  expect(view.pending?.map((p) => p.person.handle)).toEqual(["docs"]);
  expect(handlesOf(view)).toEqual(["drew", "devtool"]);

  // And "docs" cannot read the conversation until the owner approves
  expect((await convoz(w.box, docs.sid, ["read", String(conv)])).code).toBe(3);
  must(await w.owner.client.post(`/api/conversations/${conv}/participants/${ids.docs}/approve`), "approve docs");
  expect((await convoz(w.box, docs.sid, ["read", String(conv)])).code).toBe(0);
  expect((await viewOf(w.owner, conv)).pending ?? []).toEqual([]);
});
