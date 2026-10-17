import { convoz, createConversation, ownerSays } from "../lib/chat.ts";
import { stepped } from "../lib/machines.ts";
import { expect, scenario } from "../lib/scenario.ts";
import { must } from "../lib/owner.ts";
import { agentCreates, asAgent, handlesOf, idsOf, startSession, viewOf, world } from "../lib/wp3.ts";

// WP3's part of security.feature (SEC-4, SEC-6, AC-26): pickup is the one way an agent gets into a conversation by itself, and only
// into one the owner opened. The routes are listed at the top of tests/conversations.wp3.spec.ts.

scenario("Revoking a machine releases its pickups", { tag: ["@api"] }, async ({ server }) => {
  // Given a "devtool" session on "box-2" picked up conversation 60
  const w = await world(server, { pickup: true });
  const conv = await createConversation(w.owner, { title: "Weekly usage", participants: [] });
  must(await w.owner.client.post(`/api/conversations/${conv}/pickup/open`), "open for pickup");
  const dev = await startSession(w.box, "devtool", "devtool");
  must(await asAgent(w.srv, dev.lease, "POST", `/api/conversations/${conv}/pickup`, {}), "devtool picks up");
  const held = await viewOf(w.owner, conv);
  expect(held.pickup).toBe("taken");
  expect(held.picked_up_by?.handle).toBe("devtool");

  // When the owner revokes "box-2"
  must(await stepped(w.owner, "POST", `/api/machines/${w.box2.id}/revoke`, {}, "machine.revoke", w.box2.id), "revoke box-2");

  // Then conversation 60 shows as open for pickup again
  const after = await viewOf(w.owner, conv);
  expect(after.pickup).toBe("open");
  expect(after.picked_up_by).toBeUndefined();
});

scenario("A pickup gives no history before the pickup", { tag: ["@cli"] }, async ({ server }) => {
  // Given machine "box-2" has the pickup scope
  const w = await world(server, { pickup: true });

  // And the owner opened conversation 60 with 12 messages for pickup
  const conv = await createConversation(w.owner, { title: "Weekly usage", participants: [] });
  for (let i = 1; i <= 12; i++) await ownerSays(w.owner, conv, `old message ${i}`);
  must(await w.owner.client.post(`/api/conversations/${conv}/pickup/open`), "open for pickup");

  // When "devtool" picks it up
  const dev = await startSession(w.box, "devtool", "devtool");
  const picked = await convoz(w.box, dev.sid, ["pickup", String(conv)]);
  expect(picked.code, picked.stderr).toBe(0);
  await ownerSays(w.owner, conv, "first message after the pickup");

  // Then "convoz read 60" shows no message older than the pickup
  const read = await convoz(w.box, dev.sid, ["read", String(conv)]);
  expect(read.code, read.stderr).toBe(0);
  expect(read.stdout).toContain("first message after the pickup");
  expect(read.stdout).not.toMatch(/old message/);
});

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
  expect(handlesOf(view)).toEqual(["devtool"]);

  // And "docs" cannot read the conversation until the owner approves
  expect((await convoz(w.box, docs.sid, ["read", String(conv)])).code).toBe(3);
  must(await w.owner.client.post(`/api/conversations/${conv}/participants/${ids.docs}/approve`), "approve docs");
  expect((await convoz(w.box, docs.sid, ["read", String(conv)])).code).toBe(0);
  expect((await viewOf(w.owner, conv)).pending ?? []).toEqual([]);
});

scenario("A conversation not opened for pickup cannot be picked up", { tag: ["@api"] }, async ({ server }) => {
  // Given machine "box-2" has the pickup scope
  const w = await world(server, { pickup: true });
  const conv = await createConversation(w.owner, { title: "Ship search filters", participants: [] });
  const dev = await startSession(w.box, "devtool", "devtool");

  // When "devtool" runs "convoz pickup 41" for a conversation nobody opened for pickup
  const res = await asAgent(w.srv, dev.lease, "POST", `/api/conversations/${conv}/pickup`, {});
  const cli = await convoz(w.box, dev.sid, ["pickup", String(conv)]);

  // Then the server answers 403
  expect(res.status).toBe(403);
  expect(cli.code).toBe(3);
  expect(handlesOf(await viewOf(w.owner, conv))).toEqual(["drew"]);
  expect((await viewOf(w.owner, conv)).pickup).toBe("closed");
});
