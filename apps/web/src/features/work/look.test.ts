import assert from "node:assert/strict";
import { test } from "node:test";
import type { Conversation, Deliveries, Plan, PlanBoard } from "@convoz/api-client";
import { sections } from "./look.ts";

const NOW = Date.UTC(2026, 9, 28, 12);

const conv = (id: number, title: string, handles: string[], stale = false) =>
  ({ id, title, stale, participants: handles.map((handle) => ({ kind: "agent", handle })) }) as unknown as Conversation;

const plan = (conversation_id: number, handle: string, p: Partial<Plan> = {}): Plan => ({
  conversation_id,
  identity_id: 1,
  handle,
  now: [],
  doing: "",
  next: [],
  waiting: [],
  done: [],
  updated_at: NOW - 60_000,
  ...p,
});

const board = (plans: Plan[], attention: PlanBoard["attention"] = [], liveness: "ok" | "logged_out" = "ok"): PlanBoard => ({
  now: NOW,
  plans,
  agents: [...new Set(plans.map((p) => p.handle))].map((handle) => ({ identity_id: 1, handle, state: "idle", doing: "", online: true, liveness }) as PlanBoard["agents"][number]),
  asks: [],
  attention,
});

const deliveries = (late: { conv: number; handle: string; text: string }[]): Deliveries =>
  ({ now: NOW, shipped: [], deliveries: late.map((l) => ({ conversation_id: l.conv, handle: l.handle, text: l.text, state: "late", due: NOW - 60_000 })) }) as unknown as Deliveries;

const shape = (b: ReturnType<typeof sections>) => b.sections.map((s) => [s.label, s.rows.map((r) => `${r.title}: ${r.text}`)]);

test("each plan goes in the highest section that applies, in the order Needs you, Blocked or late, In progress, Planned", () => {
  const convs = [conv(1, "Waits", ["a"]), conv(2, "Blocked", ["a"]), conv(3, "Late", ["a"]), conv(4, "Doing", ["a"]), conv(5, "Next", ["a"]), conv(6, "Done", ["a"])];
  const plans = [
    plan(1, "a", { now: [{ text: "Docs pass" }], waiting: [{ text: "Approve", since: NOW }] }),
    plan(2, "a", { now: [{ text: "Deploy" }], blocked: "CI is down" }),
    plan(3, "a", { deliver: [{ text: "Release notes", due: NOW - 60_000 }] as Plan["deliver"] }),
    plan(4, "a", { now: [{ text: "Filter chips" }] }),
    plan(5, "a", { next: ["Changelog"] }),
    plan(6, "a", { done: [{ text: "Old work", at: NOW - 1000 }] }),
  ];
  const got = sections(board(plans), deliveries([{ conv: 3, handle: "a", text: "Release notes" }]), convs, NOW);
  assert.deepEqual(shape(got), [
    ["Needs you", ["Waits: Approve"]],
    ["Blocked or late", ["Blocked: Blocked: CI is down", "Late: Late: Release notes"]],
    ["In progress", ["Doing: Filter chips"]],
    ["Planned", ["Next: Changelog"]],
  ]);
  assert.deepEqual(got.done.map((d) => d.text), ["Old work"]);
});

test("an open ask puts its agent under Needs you, with or without a plan", () => {
  const got = sections(board([], [{ conversation_id: 1, state: "waiting", handle: "a", text: "Ship it?" }]), null, [conv(1, "Asks", ["a"])], NOW);
  assert.deepEqual(shape(got), [["Needs you", ["Asks: Ship it?"]]]);
});

test("a stale chat is hidden from In progress and Planned, and counted, but still shows when it needs the owner", () => {
  const convs = [conv(1, "Closed", ["a"], true), conv(2, "Old ask", ["a"], true)];
  const plans = [plan(1, "a", { now: [{ text: "Closed work" }] }), plan(2, "a", { waiting: [{ text: "Pick a name", since: NOW }] })];
  const hidden = sections(board(plans), null, convs, NOW);
  assert.deepEqual(shape(hidden), [["Needs you", ["Old ask: Pick a name"]]]);
  assert.equal(hidden.hidden, 1);
  const shown = sections(board(plans), null, convs, NOW, true);
  assert.deepEqual(shape(shown), [["Needs you", ["Old ask: Pick a name"]], ["In progress", ["Closed: Closed work"]]]);
});

test("a logged-out agent with work is blocked; a plan of an agent no longer in the chat, or of a chat not in the list, is left out", () => {
  const got = sections(board([plan(1, "a", { now: [{ text: "Work" }] }), plan(2, "a", { now: [{ text: "Gone" }] }), plan(9, "a", { now: [{ text: "Trash" }] })], [], "logged_out"), null, [conv(1, "Here", ["a"]), conv(2, "Left", ["b"])], NOW);
  assert.deepEqual(shape(got), [["Blocked or late", ["Here: Logged out"]]]);
});
