import { failure } from "../../shared/failure.ts";
import { toast, type Undo } from "./toast.ts";

/** toastFailure says why a write failed. When sending it again could help (no answer, the server restarting), the toast carries Retry, which runs `retry`. */
export function toastFailure(err: unknown, retry: Undo): void {
  const f = failure(err);
  if (!f) return;
  if (f.retry) toast(f.text, retry, "Retry");
  else toast(f.text);
}
