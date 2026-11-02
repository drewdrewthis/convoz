import assert from "node:assert/strict";
import { test } from "node:test";
import { inDevScope } from "./devScope.ts";

test("the worker leaves /dev and everything under it to the network", () => {
  for (const p of ["/dev", "/dev/", "/dev/chats/12", "/dev/assets/main-abc.js", "/dev/index.html"]) assert.equal(inDevScope(p), true, p);
});

test("the worker still answers the real app", () => {
  for (const p of ["/", "/chats", "/developer", "/devices", "/assets/main-abc.js", "/api/dev", "/chats/dev"]) assert.equal(inDevScope(p), false, p);
});
