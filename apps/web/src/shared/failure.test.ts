import assert from "node:assert/strict";
import { test } from "node:test";
import { ApiError, failure, humanError } from "./failure.ts";

// Owner report: a reply sent while the server restarted for a deploy (about 25 s of 502s) showed nothing useful.

test("a gateway with nothing behind it (502, 503, 504) or no answer at all is worth a retry, and says the server may be restarting", () => {
  for (const err of [new ApiError("Bad Gateway", 502, undefined), new ApiError("", 503, undefined), new ApiError("", 504, undefined), new TypeError("Failed to fetch")]) {
    const f = failure(err);
    assert.ok(f, String(err));
    assert.equal(f.retry, true, String(err));
    assert.match(f.text, /restarting/i, String(err));
  }
});

test("a refusal (4xx) is the server's words, with no retry: sending it again cannot change it", () => {
  const bad = new ApiError("A machine with that name exists.", 400, "machine_name_taken");
  assert.deepEqual(failure(bad), { text: "A machine with that name exists.", retry: false });
  const changed = new ApiError("version mismatch", 409, "conflict");
  assert.deepEqual(failure(changed), { text: humanError(changed), retry: false });
});

test("an error the page already acted on (a 401 that went to sign in) shows nothing", () => {
  const gone = new ApiError("", 401, "session_expired");
  gone.handled = true;
  assert.equal(failure(gone), null);
});
