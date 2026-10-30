import assert from "node:assert/strict";
import { test } from "node:test";
import type { Ask, MachineRequest, Now } from "@convoz/api-client";
import { arrivals } from "./arrivals.ts";

const ask = (id: number, handle: string, question: string) => ({ id, asker: { handle }, question }) as Ask;
const machine = (id: number, name: string, handle?: string) => ({ id, name, identity: handle ? { handle } : null }) as MachineRequest;
type IdentityRequest = Now["identity_requests"][number];
const agent = (ref: string, machine: string, handle: string) => ({ ref, machine, handle }) as IdentityRequest;
const now = (asks: Ask[], machine_requests: MachineRequest[] = [], identity_requests: IdentityRequest[] = []) => ({ asks, machine_requests, identity_requests }) as Now;

test("the first load toasts nothing: what waited before the page opened is not news", () => {
  assert.deepEqual(arrivals(undefined, now([ask(1, "devtool", "Merge #415?")], [machine(9, "box-9")])), []);
});

test("a new open ask toasts who asks and the question", () => {
  assert.deepEqual(arrivals(now([]), now([ask(7, "devtool", "Merge #415 on its own?")])), ["@devtool asks: Merge #415 on its own?"]);
});

test("a new machine request toasts the machine and the agent it connects as", () => {
  assert.deepEqual(arrivals(now([]), now([], [machine(9, "drew-sweatshop", "lw-scenarios")])), ["drew-sweatshop wants to connect as @lw-scenarios"]);
});

test("a new machine request with no agent toasts the machine alone", () => {
  assert.deepEqual(arrivals(now([]), now([], [machine(10, "box-9")])), ["box-9 wants to connect"]);
});

// Drew's screenshot: the machine was already connected, so the request came as an identity request, not a machine request.
test("a new agent asking to connect from a machine already connected toasts the machine and the agent", () => {
  assert.deepEqual(arrivals(now([]), now([], [], [agent("r1", "drew-sweatshop", "lw-scenarios")])), ["drew-sweatshop wants to connect as @lw-scenarios"]);
});

test("an identity request already there toasts nothing again", () => {
  const before = now([], [], [agent("r1", "drew-sweatshop", "lw-scenarios")]);
  assert.deepEqual(arrivals(before, now([], [], [agent("r1", "drew-sweatshop", "lw-scenarios")])), []);
});

test("asks and requests already there toast nothing again", () => {
  const before = now([ask(1, "devtool", "Merge #415?")], [machine(9, "box-9")]);
  assert.deepEqual(arrivals(before, now([ask(1, "devtool", "Merge #415?")], [machine(9, "box-9")])), []);
});

test("only the new ones toast when old and new are mixed, asks before requests", () => {
  const before = now([ask(1, "devtool", "Merge #415?")], [machine(9, "box-9")]);
  const after = now([ask(1, "devtool", "Merge #415?"), ask(2, "docs", "Roll back box-3?")], [machine(9, "box-9"), machine(11, "box-2", "dev-ci")]);
  assert.deepEqual(arrivals(before, after), ["@docs asks: Roll back box-3?", "box-2 wants to connect as @dev-ci"]);
});

test("an ask that left Now toasts nothing", () => {
  assert.deepEqual(arrivals(now([ask(1, "devtool", "Merge #415?")]), now([])), []);
});
