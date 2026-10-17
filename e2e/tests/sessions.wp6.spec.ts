import { chatWorld, createConversation, inboxItems, startSession } from "../lib/chat.ts";
import { conversationsWithMentions, inboxApi, itemsOf, peekApi } from "../lib/inbox.ts";
import { send } from "../lib/http.ts";
import { bearer, lease, whoamiApi } from "../lib/machines.ts";
import { expect, scenario } from "../lib/scenario.ts";

// Bindings of the inbox halves of sessions.feature (contracts): what a lease change does to the claims it holds.

scenario("A re-mint moves the old lease's claims to the new lease", { tag: ["@api"] }, async ({ server }) => {
  // Given "box-2" holds lease A as "devtool" for client id "claude-7f3a" and lease A holds 2 inbox items
  const w = await chatWorld(server, { agents: ["devtool"] });
  await conversationsWithMentions(w.owner, 2, "devtool");
  const leaseA = await lease(w.srv, w.box2.key, { as: "devtool", clientId: "claude-7f3a" });
  const held = await itemsOf(await inboxApi(w.srv, leaseA, "claim=5&wait=0"));
  expect(held).toHaveLength(2);

  // When "box-2" mints again as "devtool" with client id "claude-7f3a"
  const leaseB = await lease(w.srv, w.box2.key, { as: "devtool", clientId: "claude-7f3a" });
  expect((await whoamiApi(w.srv, leaseA)).status).toBe(401);

  // Then the inbox items lease A held are held by lease B with the same claim tokens
  const now = await peekApi(w.srv, leaseB);
  expect(now.map((i) => [i.id, i.state, i.claim_token])).toEqual(held.map((i) => [i.id, "claimed", i.claim_token]));
});

scenario("Renewing a lease extends the claims of that session", { tag: ["@cli"] }, async ({ server, testApi }) => {
  // Given a session of "devtool" holds 3 inbox items with a 5-minute visibility
  const w = await chatWorld(server, { agents: ["devtool"] });
  await conversationsWithMentions(w.owner, 3, "devtool");
  const s1 = await startSession(w.box, "devtool", "s1");
  const s2 = await startSession(w.box, "devtool", "s2");
  const claimed = await inboxItems(w.box, s1.sid, ["--claim", "3", "--wait", "0", "--visibility", "5m"]);
  expect(claimed).toHaveLength(3);

  // When the session renews its lease 4 minutes later
  await testApi(w.srv).advanceClock(4 * 60_000);
  const renewed = await send(w.srv.target, "POST", "/api/sessions/renew", { json: {}, ...bearer(s1.lease) });
  expect(renewed.status, renewed.text).toBe(200);

  // Then a second session of "devtool" polling 2 minutes after that gets none of the 3 items
  await testApi(w.srv).advanceClock(2 * 60_000);
  expect(await inboxItems(w.box, s2.sid, ["--claim", "3", "--wait", "0"])).toEqual([]);
});
