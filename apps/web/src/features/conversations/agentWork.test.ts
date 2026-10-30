import assert from "node:assert/strict";
import { test } from "node:test";
import type { FeedItem, Plan, PlanAgent } from "@convoz/api-client";
import { agentWork } from "./agentWork.ts";

const H = 3_600_000;
const NOW = 100 * H;
const ME = 7;
const CONV = 179;

const plan = (o: Partial<Plan> = {}) => ({ conversation_id: CONV, identity_id: ME, handle: "dev", now: [], doing: "", next: [], waiting: [], done: [], deliver: [], updated_at: NOW - 19 * H, ...o }) as Plan;
const item = (o: Partial<FeedItem>) => ({ id: 1, conversation_id: CONV, agent_id: ME, key: "k", seq: 1, plan: "main", state: "started", title: "t", version: 1, can_accept: false, updated_at: NOW - H, ...o }) as FeedItem;
const live = { identity_id: ME, handle: "dev", state: "idle", doing: "", online: true, liveness: "ok" } as PlanAgent;
const work = (p: Plan | undefined, items: FeedItem[], agent: PlanAgent | undefined = live) => agentWork({ plan: p, agent, items, id: ME, conv: CONV, now: NOW });

test("an old plan with no Now still shows the open items of every plan: Working, both items, the newest update", () => {
  const queued = item({ id: 1, seq: 5, state: "pending", title: "master-ff", updated_at: NOW - 10 * 60_000 });
  const started = item({ id: 2, seq: 3, plan: "protect-master", title: "protect master", updated_at: NOW - 2 * H });
  const w = work(plan({ done: Array.from({ length: 20 }, (_, i) => ({ text: `d${i}`, at: NOW - 20 * H })) }), [queued, started]);
  assert.deepEqual(w.state, { word: "Working", tone: "green", sub: { updated: NOW - 10 * 60_000 } });
  assert.deepEqual(w.items.map((i) => i.title), ["protect master", "master-ff"]);
});

test("a blocking item is Waiting on you", () => {
  const w = work(plan(), [item({ id: 1 }), item({ id: 2, seq: 2, state: "blocking", plan: "other" })]);
  assert.equal(w.state?.word, "Waiting on you");
  assert.equal(w.state?.tone, "amber");
});

test("only pending items is Queued, with or without a plan", () => {
  for (const p of [plan(), undefined]) {
    const w = work(p, [item({ state: "pending" })]);
    assert.equal(w.state?.word, "Queued");
    assert.equal(w.items.length, 1);
  }
});

test("items of another agent, of another conversation and closed ones are not this card's", () => {
  const w = work(plan(), [item({ id: 1, agent_id: 9 }), item({ id: 2, conversation_id: 5 }), item({ id: 3, state: "fyi" }), item({ id: 4, state: "done" })]);
  assert.deepEqual(w.items, []);
  assert.deepEqual(w.state, { word: "Done", tone: "grey", sub: { updated: NOW - 19 * H } });
});

test("with no items the plan rules are as before", () => {
  const upd = { updated: NOW - 19 * H };
  assert.equal(work(undefined, []).state, null);
  assert.deepEqual(work(plan({ doing: "x" }), []).state, { word: "Working", tone: "green", sub: upd });
  assert.deepEqual(work(plan({ doing: "x", eta: NOW - 1 }), []).state, { word: "Behind", tone: "amber", sub: upd });
  assert.deepEqual(work(plan({ doing: "x", due_at: NOW - 1 }), []).state, { word: "No update", tone: "amber", sub: { text: "no update for 2 h" } });
  assert.deepEqual(work(plan({ blocked: "CI" }), []).state, { word: "Blocked", tone: "red", sub: upd });
  assert.deepEqual(work(plan({ waiting: [{ text: "w", since: 1 }] }), []).state, { word: "Waiting on you", tone: "amber", sub: upd });
  assert.deepEqual(work(plan(), [], { ...live, liveness: "logged_out", last_seen_at: 5 }).state, { word: "Logged out", tone: "amber", sub: { seen: 5 } });
  assert.deepEqual(work(plan(), [], { ...live, liveness: "not_responding" }).state, { word: "Not responding", tone: "amber", sub: { seen: 0 } });
});
