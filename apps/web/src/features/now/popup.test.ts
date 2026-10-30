import assert from "node:assert/strict";
import { test } from "node:test";
import type { Ask, IdentityRequest, MachineRequest, Now } from "@convoz/api-client";
import { toPop } from "./popup.ts";

const ask = (id: number, urgent: boolean) => ({ id, urgent, asker: { handle: "devtool" }, question: `Q${id}?` }) as Ask;
const machine = (id: number, handle?: string) => ({ id, name: `box-${id}`, identity: handle ? { handle } : null }) as MachineRequest;
const agent = (ref: string) => ({ ref, machine: "drew-sweatshop", handle: "lw-scenarios" }) as IdentityRequest;
const now = (asks: Ask[], machine_requests: MachineRequest[] = [], identity_requests: IdentityRequest[] = []) => ({ asks, machine_requests, identity_requests }) as Now;
const keys = (n: Now | null, seen: ReadonlySet<string> = new Set()) => toPop(n, seen).map((x) => x.key);

test("nothing pops before Now has loaded", () => {
  assert.deepEqual(keys(null), []);
});

test("an urgent open ask pops, keyed by its id", () => {
  assert.deepEqual(keys(now([ask(7, true)])), ["a7"]);
});

test("an ask that is not urgent never pops", () => {
  assert.deepEqual(keys(now([ask(7, false)])), []);
});

test("machine requests pop, with or without an agent, keyed as their cards are", () => {
  assert.deepEqual(keys(now([], [machine(9), machine(10, "dev-ci")])), ["m9", "m10"]);
});

// Drew's screenshot: an agent asking to connect from a machine already connected is an identity request.
test("an agent asking to connect from a machine already connected pops, keyed by its ref", () => {
  assert.deepEqual(keys(now([], [], [agent("r1")])), ["r1"]);
});

test("requests pop before urgent asks: machine requests, then identity requests, then asks", () => {
  assert.deepEqual(keys(now([ask(1, true), ask(2, false), ask(3, true)], [machine(9)], [agent("r1")])), ["m9", "r1", "a1", "a3"]);
});

test("what the owner already saw does not pop again", () => {
  assert.deepEqual(keys(now([ask(1, true), ask(3, true)], [machine(9)], [agent("r1")]), new Set(["m9", "a1"])), ["r1", "a3"]);
});

test("each popped item carries what its action buttons need", () => {
  const n = now([ask(1, true)], [machine(9, "dev-ci"), machine(10)], [agent("r1")]);
  assert.deepEqual(
    toPop(n, new Set()).map((x) => x.kind),
    ["login", "plain", "session", "ask"],
  );
});
