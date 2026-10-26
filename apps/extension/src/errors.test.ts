import assert from "node:assert/strict";
import { test } from "node:test";
import { ApiFailure, describe } from "./errors.ts";

const server = "https://convoz.example.ts.net";

test("each failure reads in plain words, as a sentence", () => {
  assert.equal(describe(new ApiFailure(null), server), "Cannot reach https://convoz.example.ts.net.");
  assert.equal(describe(new ApiFailure(401, "unauthenticated", "Sign in."), server), "Signed out. Sign in to Convoz again.");
  assert.equal(describe(new ApiFailure(403, "csrf", "This request did not come from the Convoz app."), server), "Not allowed (403): set CONVOZ_EXTENSION_ORIGIN on the server.");
  assert.equal(describe(new ApiFailure(400, "invalid_request", "A title has 1 to 120 characters."), server), "Send failed: A title has 1 to 120 characters.");
  assert.equal(describe(new ApiFailure(500), server), "Send failed: HTTP 500.");
});

test("a 403 that is not the CSRF check says the server's own reason", () => {
  assert.equal(describe(new ApiFailure(403, "forbidden", "That agent is disabled."), server), "Send failed: That agent is disabled.");
});

test("a load failure and a panel error keep their own words", () => {
  assert.equal(describe(new ApiFailure(502, "bad_gateway", "Down."), server, "Loading"), "Loading failed: Down.");
  assert.equal(describe(new Error("This page cannot be captured."), server), "This page cannot be captured.");
  assert.equal(describe(new Error("no tab"), server), "no tab.");
});
