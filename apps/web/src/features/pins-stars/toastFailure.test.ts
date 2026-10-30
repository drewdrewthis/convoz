import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { ApiError } from "../../shared/failure.ts";
import { useToast } from "./toast.ts";
import { toastFailure } from "./toastFailure.ts";

// Owner report: a reply sent while the server restarted for a deploy (about 25 s of 502s) showed nothing useful.

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
