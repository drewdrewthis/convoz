import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { toastFailure, useToast } from "../features/pins-stars/toast.ts";
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

test("a failed write toasts its words; a retryable one carries Retry, which runs the write again", () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    let again = 0;
    toastFailure(new ApiError("", 502, undefined), () => void again++);
    const s = useToast.getState();
    assert.match(s.text, /restarting/i);
    assert.equal(s.label, "Retry");
    assert.ok(s.undo);
    void s.undo();
    assert.equal(again, 1);

    toastFailure(new ApiError("A machine with that name exists.", 400, "machine_name_taken"), () => void again++);
    assert.equal(useToast.getState().text, "A machine with that name exists.");
    assert.equal(useToast.getState().undo, null);

    useToast.setState({ text: "" });
    const gone = new ApiError("", 401, "session_expired");
    gone.handled = true;
    toastFailure(gone, () => void again++);
    assert.equal(useToast.getState().text, "");
  } finally {
    mock.timers.reset();
  }
});
