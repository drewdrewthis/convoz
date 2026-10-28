import assert from "node:assert/strict";
import { test } from "node:test";
import { addBase, stripBase } from "./basePath.ts";

test("the real app has no base: every path is its own", () => {
  assert.equal(stripBase("", "/chats/12"), "/chats/12");
  assert.equal(addBase("", "/chats/12"), "/chats/12");
});

test("a dev path is read as the app path under it", () => {
  assert.equal(stripBase("/dev", "/dev/chats/12"), "/chats/12");
  assert.equal(stripBase("/dev", "/dev/"), "/");
  assert.equal(stripBase("/dev", "/dev"), "/");
  assert.equal(stripBase("/dev", "/developer"), "/developer");
  assert.equal(stripBase("/dev", "/chats"), "/chats");
});

test("an app URL gets the dev base once, with its query and hash", () => {
  assert.equal(addBase("/dev", "/chats/12?x=1#m3"), "/dev/chats/12?x=1#m3");
  assert.equal(addBase("/dev", "/"), "/dev/");
  assert.equal(addBase("/dev", "/signin?next=%2Fdev%2Fchats"), "/dev/signin?next=%2Fdev%2Fchats");
  assert.equal(addBase("/dev", "/dev/chats"), "/dev/chats");
  assert.equal(addBase("/dev", "/developer"), "/dev/developer");
});

test("the API, other origins and relative URLs keep their address", () => {
  for (const to of ["/api/me", "//evil.example/x", "https://example.com/", "chats", "#m3", ""]) assert.equal(addBase("/dev", to), to);
});
