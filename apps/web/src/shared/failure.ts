// What went wrong, in the owner's words. Pure (no fetch, no page), so it is tested under node; api.ts exports it again.

/** An answer that was not 2xx. `code` is the server's error code (error.code). */
export class ApiError extends Error {
  status: number;
  code: string | undefined;
  /** true when the page already acted on it (a 401 that sends the browser to sign in): show nothing. */
  handled = false;
  constructor(message: string, status: number, code: string | undefined) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// These server messages are written for the owner and name what to fix (a machine name, a field); every other code gets the
// generic line, so an internal or unexpected message never reaches the page.
const SHOWN_AS_SENT = new Set(["machine_name_taken", "invalid_request", "handle_taken", "code_mismatch", "last_passkey", "invalid_code", "rate_limited"]);

/** humanError turns anything that can go wrong into one plain sentence ("" for an error the page already handled). */
export function humanError(err: unknown): string {
  if (err instanceof ApiError && err.handled) return "";
  const name = err && (err as Error).name;
  if (name === "NotAllowedError") return "The passkey prompt was closed or timed out. Try again.";
  if (name === "AbortError") return "The passkey prompt was cancelled. Try again.";
  if (name === "InvalidStateError") return "This device already has a Convoz passkey. Use another device or a security key.";
  if (name === "NotSupportedError" || name === "SecurityError") return "This browser cannot use that passkey here.";
  if (err instanceof ApiError) {
    switch (err.code) {
      case "ceremony_invalid": return "The passkey check timed out. Tap again.";
      case "step_up_invalid": return "That passkey check was used up or timed out. Tap again.";
      case "step_up_required": return "This needs a fresh passkey check. Tap again.";
      case "passkey_too_new":
        return "This passkey was added less than 24 hours ago. Actions like this need an older passkey, so try again later or sign in with an older one.";
      case "invalid_credential": return "That passkey did not work. Try again.";
      case "machine_cap": return "Ten machines are active. Revoke one before approving another.";
      case "bootstrap_used": return "This setup link was already used.";
      case "bootstrap_expired": return "This setup link expired.";
      case "bootstrap_invalid": return "This setup link is not valid.";
      case "not_found": return "That is gone. Reload the page.";
      case "limited_device": return "This device may only add a passkey.";
    }
    if (err.code && SHOWN_AS_SENT.has(err.code)) return err.message;
    return "Something went wrong. Try again.";
  }
  if (name === "TypeError") return "Could not reach Convoz. Check your connection and try again.";
  return "Something went wrong. Try again.";
}

/** Said when a write got no answer: the link is down, or a gateway had nothing behind it (the server restarting for a deploy). */
export const UNREACHED = "Could not reach Convoz. The connection is down or Convoz is restarting.";

// A gateway answering for a server that is not there; the same request a moment later can work.
const GATEWAY = new Set([502, 503, 504]);

/** A failed write in the owner's words, and whether sending the same request again could help. */
export interface Failure {
  text: string;
  retry: boolean;
}

/** failure reads a failed write: no answer or a gateway error is worth a retry; a refusal (4xx) is the server's words, which a retry cannot change; an error the page already acted on is null. */
export function failure(err: unknown): Failure | null {
  if (err instanceof ApiError && err.handled) return null;
  if (err instanceof TypeError || (err instanceof ApiError && GATEWAY.has(err.status))) return { text: UNREACHED, retry: true };
  return { text: humanError(err), retry: false };
}
