import assert from "node:assert/strict";
import { test } from "node:test";
import { activeAgents, type Identity } from "./identities.ts";

const who = (handle: string, kind: Identity["kind"], disabled = false): Identity => ({ kind, handle, disabled });

test("the picker lists active agents only, in the server's order", () => {
  const list = [who("drew", "human"), who("scout", "agent"), who("old", "agent", true), who("ada", "agent")];
  assert.deepEqual(activeAgents(list).map((i) => i.handle), ["scout", "ada"]);
});

test("no active agents leaves the picker empty", () => {
  assert.deepEqual(activeAgents([who("drew", "human"), who("old", "agent", true)]), []);
});
