import assert from "node:assert/strict";
import { test } from "node:test";
import { serverOrigin } from "./server.ts";

test("the server address becomes its origin", () => {
  assert.equal(serverOrigin(" https://convoz.example.ts.net/chats/4 "), "https://convoz.example.ts.net");
  assert.equal(serverOrigin("http://localhost:8080/"), "http://localhost:8080");
});

test("an address outside https and localhost is refused", () => {
  for (const typed of ["http://convoz.example.ts.net", "javascript:alert(1)", "file:///etc/passwd", "convoz", ""]) assert.equal(serverOrigin(typed), null, typed);
});
