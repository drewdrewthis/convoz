import { inboxItems, convoz, ownerSays, messagesOf, agentSays, agentPost } from "../lib/chat.ts";
import { send } from "../lib/http.ts";
import { bearer, stepped } from "../lib/machines.ts";
import { board, mustPlan, putPlan, planWorld, type Board, type PlanWorld } from "../lib/plan.ts";
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

scenario("Nudges come 15 minutes after the last update, then once per hour, and stop at 3", { tag: ["@api"] }, async ({ server, testApi }, info) => {
  info.setTimeout(60_000);
  const p = await planWorld(server, { docsIn: false });
  // Given "devtool" planned Doing "Building invites" with no eta
  must(await putPlan(p.w.srv, p.dev.lease, p.conv, { doing: "Building invites" }), "plan");
  const nudges = async (): Promise<number> => {
    const due = (await inboxItems(p.w.box, p.dev.sid, [])).filter((i) => i.reason === "status_due");
    for (const d of due) expect((await convoz(p.w.box, p.dev.sid, ["ack", `${d.id}:${d.claim_token}`])).code).toBe(0);
    return due.length;
  };
  // When the server clock moves on; the agent claims and acks each status_due item
  await testApi(p.w.srv).advanceClock(14 * MIN);
  expect(await nudges()).toBe(0); // 14 min
  await testApi(p.w.srv).advanceClock(2 * MIN);
  expect(await nudges()).toBe(1); // 16 min
  await testApi(p.w.srv).advanceClock(30 * MIN);
  expect(await nudges()).toBe(0); // 46 min
  await testApi(p.w.srv).advanceClock(30 * MIN);
  expect(await nudges()).toBe(1); // 1 h after the first
  await testApi(p.w.srv).advanceClock(HOUR);
  expect(await nudges()).toBe(1); // 2 h after the first
  await testApi(p.w.srv).advanceClock(HOUR);
  expect(await nudges()).toBe(0); // 3 h after the first: the cap is 3

  // And a new plan starts the count again
  must(await putPlan(p.w.srv, p.dev.lease, p.conv, { doing: "Building invites" }), "plan again");
  await testApi(p.w.srv).advanceClock(14 * MIN);
  expect(await nudges()).toBe(0);
  await testApi(p.w.srv).advanceClock(2 * MIN);
  expect(await nudges()).toBe(1);
});

scenario("A plan that is blocked or waits on the owner is not nudged", { tag: ["@api"] }, async ({ server, testApi }) => {
  const p = await planWorld(server, { docsIn: false });
  const nudges = async (): Promise<number> => (await inboxItems(p.w.box, p.dev.sid, [])).filter((i) => i.reason === "status_due").length;
  // Given "devtool" planned Doing "Building invites" and Waiting on you "Approve the deploy"
  must(await putPlan(p.w.srv, p.dev.lease, p.conv, { doing: "Building invites", waiting: ["Approve the deploy"] }), "waiting plan");
  // When 3 hours pass, then "devtool" gets no status_due item
  await testApi(p.w.srv).advanceClock(3 * HOUR);
  expect(await nudges()).toBe(0);

  // Given "devtool" planned Doing "Building invites" and Blocked "CI is down"
  must(await putPlan(p.w.srv, p.dev.lease, p.conv, { doing: "Building invites", blocked: "CI is down" }), "blocked plan");
  // When 3 hours pass, then "devtool" gets no status_due item
  await testApi(p.w.srv).advanceClock(3 * HOUR);
  expect(await nudges()).toBe(0);
});

/** The agent's open status_due items in the conversation, each acked; their message texts. */
async function asks(p: PlanWorld): Promise<string[]> {
  const due = (await inboxItems(p.w.box, p.dev.sid, [])).filter((i) => i.reason === "status_due" && i.conversation.id === p.conv);
  for (const d of due) expect((await convoz(p.w.box, p.dev.sid, ["ack", `${d.id}:${d.claim_token}`])).code).toBe(0);
  return due.map((d) => d.message.body);
}

/** "devtool" posts n messages in the conversation. */
async function posts(p: PlanWorld, n: number): Promise<void> {
  for (let i = 0; i < n; i++) await agentSays(p.w.srv, p.dev.lease, p.conv, `working on it ${i + 1}`);
}

scenario("An agent that keeps posting with a plan 30 minutes old is asked once an hour", { tag: ["@api"] }, async ({ server, testApi }) => {
  const p = await planWorld(server, { docsIn: false });
  // Given "devtool" planned Doing "Building invites" with an estimate of 3 hours (so the timed nudge for a late step stays out of it)
  must(await putPlan(p.w.srv, p.dev.lease, p.conv, { doing: "Building invites", eta: "180m" }), "plan");
  // When 10 minutes pass and "devtool" posts 3 messages, then it gets no status_due item
  await testApi(p.w.srv).advanceClock(10 * MIN);
  await posts(p, 3);
  expect(await asks(p)).toEqual([]);
  // When 21 more minutes pass and "devtool" posts once more, then one status_due item says no update for 31 min
  await testApi(p.w.srv).advanceClock(21 * MIN);
  await posts(p, 1);
  const first = await asks(p);
  expect(first).toHaveLength(1);
  expect(first[0]).toContain("has had no update for 31 min");
  // When "devtool" acks it and posts 3 more messages, then no status_due item
  await posts(p, 3);
  expect(await asks(p)).toEqual([]);
  // When an hour passes and "devtool" posts 3 more messages, then one status_due item
  await testApi(p.w.srv).advanceClock(HOUR);
  await posts(p, 3);
  expect(await asks(p)).toHaveLength(1);
});

scenario("A plan that is done, waits on the owner or is blocked is not asked for an update while the agent keeps posting", { tag: ["@api"] }, async ({ server, testApi }) => {
  const p = await planWorld(server, { docsIn: false });
  // Given "devtool" planned Done "Board feed", then in turn Doing "Building invites" with Waiting on you "Approve the deploy", and Doing with Blocked "CI is down"
  for (const body of [{ done: ["Board feed"] }, { doing: "Building invites", waiting: ["Approve the deploy"] }, { doing: "Building invites", blocked: "CI is down" }]) {
    must(await putPlan(p.w.srv, p.dev.lease, p.conv, body), "plan");
    // When 31 minutes pass after each plan and "devtool" posts 3 messages
    await testApi(p.w.srv).advanceClock(31 * MIN);
    await posts(p, 3);
    // Then "devtool" gets no status_due item
    expect(await asks(p)).toEqual([]);
  }
});

scenario("An agent with no plan is asked once it has worked in the conversation for 30 minutes", { tag: ["@api"] }, async ({ server, testApi }) => {
  const p = await planWorld(server, { docsIn: false });
  // Given the owner wrote in the conversation (the work there is for him)
  await ownerSays(p.w.owner, p.conv, "Please build the invites");
  // When "devtool" posts 3 messages where it has no plan, then no status_due item
  await posts(p, 3);
  expect(await asks(p)).toEqual([]);
  // When 31 minutes pass and "devtool" posts once more, then one status_due item says it has no plan
  await testApi(p.w.srv).advanceClock(31 * MIN);
  await posts(p, 1);
  const due = await asks(p);
  expect(due).toHaveLength(1);
  expect(due[0]).toContain(`You have no plan in conversation ${p.conv}.`);
});

scenario("An agent with no plan is not asked in a conversation the owner did not write in", { tag: ["@api"] }, async ({ server, testApi }) => {
  const p = await planWorld(server, { docsIn: false });
  // When "devtool" posts 3 messages, 31 minutes pass and it posts 3 more, with no message from the owner, then no status_due item
  await posts(p, 3);
  await testApi(p.w.srv).advanceClock(31 * MIN);
  await posts(p, 3);
  expect(await asks(p)).toEqual([]);
});

scenario("An agent with a late plan that only replies in threads is still asked", { tag: ["@api"] }, async ({ server, testApi }) => {
  const p = await planWorld(server, { docsIn: false });
  // Given "devtool" has a plan in conversation 41 that is 31 minutes old
  must(await putPlan(p.w.srv, p.dev.lease, p.conv, { doing: "Building invites" }), "plan");
  const root = await ownerSays(p.w.owner, p.conv, "Please build the invites");
  await testApi(p.w.srv).advanceClock(31 * MIN);
  // When "devtool" posts 4 replies in threads of conversation 41
  for (let i = 0; i < 4; i++) must(await agentPost(p.w.srv, p.dev.lease, p.conv, `merged ${i + 1}`, { thread_root_id: root }), "thread reply", 201);
  // Then "devtool" gets one "status_due" item that tells it to update its plan
  const due = await asks(p);
  expect(due).toHaveLength(1);
});

scenario("A plan with a delivery and no update for a day is asked about once a day", { tag: ["@api"] }, async ({ server, testApi }) => {
  const p = await planWorld(server, { docsIn: false });
  // The clock moves at most 10 hours between two inbox calls, so the 12-hour lease of "devtool" stays alive.
  const after = async (hours: number): Promise<string[]> => {
    const got: string[] = [];
    for (let left = hours; left > 0; left -= 10) {
      await testApi(p.w.srv).advanceClock(Math.min(left, 10) * HOUR);
      got.push(...(await asks(p)));
    }
    return got;
  };
  // Given "devtool" planned to deliver "Search filters live" in 5 days, with nothing in Now
  await mustPlan(p, p.dev, ["--deliver", "Search filters live", "--due", "5d"]);
  // When 23 hours pass, then no status_due item
  expect(await after(23)).toEqual([]);
  // When 2 more hours pass, then one status_due item that says no update for 25 h
  const due = await after(2);
  expect(due).toHaveLength(1);
  expect(due[0]).toContain("has had no update for 25 h");
  // When 2 more hours pass, then none; 23 more hours, then one
  expect(await after(2)).toEqual([]);
  expect(await after(23)).toHaveLength(1);
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
