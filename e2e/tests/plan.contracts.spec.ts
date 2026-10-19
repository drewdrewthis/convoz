import { inboxItems, convoz, ownerSays, messagesOf } from "../lib/chat.ts";
import { send } from "../lib/http.ts";
import { bearer, stepped } from "../lib/machines.ts";
import { board, putPlan, planWorld, type Board } from "../lib/plan.ts";
import { must } from "../lib/owner.ts";
import { expect, scenario } from "../lib/scenario.ts";

// contracts/plan.feature. The contract is the block at the top of lib/plan.ts.

const MIN = 60_000;
const HOUR = 60 * MIN;

scenario("The plan route checks who writes and what", { tag: ["@api"] }, async ({ server }) => {
  const p = await planWorld(server, { docsIn: false });
  const ok = { doing: "Building invites", eta: "30m", next: ["Reply chip"] };

  // When "devtool" sends PUT /api/conversations/41/plan with doing, eta "30m" and next
  const res = await putPlan(p.w.srv, p.dev.lease, p.conv, ok);
  // Then the server answers 200 with the plan, its eta 30 minutes after the server clock and its due_at equal to the eta
  expect(res.status, res.text).toBe(200);
  const stored = res.json();
  const now = (await board(p)).now;
  expect(stored).toMatchObject({ conversation_id: p.conv, handle: "devtool", doing: "Building invites", next: ["Reply chip"], waiting: [], done: [] });
  expect(Math.abs(stored.eta - (stored.updated_at + 30 * MIN))).toBeLessThan(1_000);
  expect(stored.updated_at).toBeLessThanOrEqual(now);
  expect(stored.due_at).toBe(stored.eta);

  // And the limits answer 400 with the field
  const bad = async (body: Record<string, unknown>, field: string) => {
    const r = await putPlan(p.w.srv, p.dev.lease, p.conv, body);
    expect(r.status, JSON.stringify(body)).toBe(400);
    expect(r.json().error.field).toBe(field);
  };
  await bad({ next: ["1", "2", "3", "4", "5", "6"] }, "next");
  await bad({ doing: "x".repeat(201) }, "doing");
  await bad({ doing: "x", eta: "soon" }, "eta");
  await bad({ doing: "x", step: "4/3" }, "step");

  // And "docs" gets 403 for the same PUT, as it is not a participant
  expect((await putPlan(p.w.srv, p.docs.lease, p.conv, ok)).status).toBe(403);
  // And the owner gets 401 for the same PUT, as the route takes only an agent lease
  expect((await p.w.owner.client.request("PUT", `/api/conversations/${p.conv}/plan`, { csrf: true, json: ok })).status).toBe(401);

  // And GET /api/plans?conversation=41 as the owner lists the plan with the attention "working"
  const b = await board(p, p.conv);
  expect(b.plans.map((x) => x.handle)).toEqual(["devtool"]);
  expect(b.attention).toEqual([expect.objectContaining({ conversation_id: p.conv, state: "working", handle: "devtool", text: "Building invites" })]);
});

scenario("A plan with no Doing has no due time and Done keeps 20", { tag: ["@api"] }, async ({ server, testApi }) => {
  const p = await planWorld(server, { docsIn: false });
  // When "devtool" sends 22 plans that each finish one item (the status budget is 10 in 50 seconds)
  let last: any;
  for (let i = 1; i <= 22; i++) {
    if (i % 10 === 0) await testApi(p.w.srv).advanceClock(60_000);
    const r = await putPlan(p.w.srv, p.dev.lease, p.conv, { done: [`Item ${i}`] });
    expect(r.status, r.text).toBe(200);
    last = r.json();
  }
  // Then the stored plan holds the 20 newest Done items, newest first
  expect(last.done.map((d: { text: string }) => d.text)).toEqual(Array.from({ length: 20 }, (_, k) => `Item ${22 - k}`));
  // And its due_at is absent
  expect(last.due_at).toBeUndefined();
});

scenario("Nudges come once per 2 hours and stop at 3", { tag: ["@api"] }, async ({ server, testApi }, info) => {
  info.setTimeout(60_000);
  const p = await planWorld(server, { docsIn: false });
  // Given "devtool" planned Doing "Building invites" with eta "30m"
  must(await putPlan(p.w.srv, p.dev.lease, p.conv, { doing: "Building invites", eta: "30m" }), "plan");

  const nudges = async (): Promise<number> => {
    const due = (await inboxItems(p.w.box, p.dev.sid, [])).filter((i) => i.reason === "status_due");
    for (const d of due) expect((await convoz(p.w.box, p.dev.sid, ["ack", `${d.id}:${d.claim_token}`])).code).toBe(0);
    return due.length;
  };
  // When the server clock passes the eta; the agent claims and acks each status_due item
  await testApi(p.w.srv).advanceClock(31 * MIN);
  expect(await nudges()).toBe(1); // 0 h after the eta
  await testApi(p.w.srv).advanceClock(HOUR);
  expect(await nudges()).toBe(0);
  await testApi(p.w.srv).advanceClock(HOUR);
  expect(await nudges()).toBe(1); // 2 h
  await testApi(p.w.srv).advanceClock(2 * HOUR);
  expect(await nudges()).toBe(1); // 4 h
  await testApi(p.w.srv).advanceClock(2 * HOUR);
  expect(await nudges()).toBe(0); // 6 h: the cap is 3

  // And a new plan starts the count again
  must(await putPlan(p.w.srv, p.dev.lease, p.conv, { doing: "Building invites", eta: "30m" }), "plan again");
  await testApi(p.w.srv).advanceClock(31 * MIN);
  expect(await nudges()).toBe(1);
});

scenario("The liveness of an agent follows its watch, its acks and its session", { tag: ["@api"] }, async ({ server, testApi }) => {
  const p = await planWorld(server, { docsIn: false });
  const liveness = async (): Promise<string> => ((await board(p, p.conv)) as Board).agents.find((a) => a.handle === "devtool")!.liveness;
  // Given the owner sent "Is the build green?" in conversation 41
  await ownerSays(p.w.owner, p.conv, "Is the build green?");
  expect(await liveness()).toBe("ok");

  // When the server clock moves 10 minutes
  await testApi(p.w.srv).advanceClock(10 * MIN);
  // Then "devtool" is not responding, and so is the conversation
  const b = await board(p, p.conv);
  expect(b.agents.find((a) => a.handle === "devtool")!.liveness).toBe("not_responding");
  expect(b.attention.find((a) => a.conversation_id === p.conv)).toMatchObject({ state: "not_responding", handle: "devtool" });

  // And conversation 41 holds one system line "agent.unresponsive" for "devtool" (the timers sweep every 10 s)
  const lines = async () => (await messagesOf(p.w.owner, p.conv)).filter((m: any) => m.system?.t === "agent.unresponsive");
  await expect.poll(async () => (await lines()).length, { timeout: 15_000 }).toBe(1);

  // When "devtool" holds a long poll of its inbox, then its liveness is "ok"
  const poll = send(p.w.srv.target, "GET", "/api/inbox?wait=5&held=0", bearer(p.dev.lease));
  await expect.poll(liveness, { timeout: 4_000 }).toBe("ok");
  await poll;

  // When the owner revokes the key of machine "box-2", then its liveness is "logged_out"
  must(await stepped(p.w.owner, "POST", `/api/machines/${p.w.box2.id}/revoke`, {}, "machine.revoke", p.w.box2.id), "revoke box-2");
  await testApi(p.w.srv).advanceClock(MIN);
  await expect.poll(liveness, { timeout: 4_000 }).toBe("logged_out");
});
