// The app's one way to the server: the generated client (@convoz/api-client), its answers unwrapped by `call`.
// Components never fetch; they call the store or a feature's own functions, which use `client` here.
import { createConvozClient, type ApiErrorBody } from "@convoz/api-client";
import { reachable, unreachable } from "./connection.ts";
import { dropEarly, takeEarly } from "./early.ts";
import { forgetOffline } from "./offline.ts";

// A read the page started before the app loaded (src/early.ts) is answered from that head start.
export const client = createConvozClient("", (request) => takeEarly(request) ?? globalThis.fetch(request));
// The offline banner follows what the requests find: an answer means the link works, no answer means it does not.
client.use({
  // A 502, 503 or 504 is a gateway with nothing behind it: the link works but nothing useful answers, which the offline note also says.
  onResponse: ({ request, response }) => (response.status >= 502 ? unreachable() : reachable(request.method === "GET" && response.ok)),
  onError: () => unreachable(),
});

/**
 * isRevoking says whether a 401 code means the device or its session is gone. "unauthorized" is what the server answers a cookie it
 * no longer knows (a revoked device); the other two are the named forms. Any other code (a bad token) leaves the cache alone.
 */
export const isRevoking = (code: string | undefined): boolean => code === "device_revoked" || code === "session_expired" || code === "unauthorized";

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

/** The page is on its way out (a sign-in redirect or a finished flow): no more ticket fetches. `public`: no session needed. */
export const page = { leaving: false, public: false };

/** safeNext keeps a ?next= value only when it is a path on this site. */
export function safeNext(raw: string | null): string {
  return typeof raw === "string" && /^\/(?![/\\])[^\u0000-\u001f]*$/.test(raw) ? raw : "/";
}

/** toSignin sends the browser to sign in, then back to this page. */
export function toSignin(): void {
  page.leaving = true;
  const here = location.pathname + location.search;
  location.assign(here === "/" ? "/signin" : `/signin?next=${encodeURIComponent(here)}`);
}

interface Answer<T> {
  data?: T;
  error?: unknown;
  response: Response;
}

/**
 * call waits for one client request and returns its data, or throws ApiError. A 401 on a signed-in page sends the browser to
 * sign in (the session ended while the page was open) and marks the error handled.
 */
export async function call<T>(request: Promise<Answer<T>>): Promise<T> {
  const { data, error, response } = await request;
  if (!response.ok) {
    const body = (error && typeof error === "object" ? error : null) as ApiErrorBody | null;
    const err = new ApiError(body?.error?.message || response.statusText, response.status, body?.error?.code);
    // Only a 401 that says the device or its session is gone clears the offline cache; a network error or any other
    // refusal never does, so a poor connection cannot wipe it (design §9).
    if (response.status === 401 && isRevoking(err.code)) {
      dropEarly();
      await forgetOffline();
      if (!page.public) {
        toSignin();
        err.handled = true;
      }
    }
    throw err;
  }
  return data as T;
}

/** stepUp is the header a step-up route needs. */
export const stepUp = (id: string) => ({ "X-Convoz-Step-Up": id });

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

/** signOut ends the session and opens the sign-in page. A failure is handed to `fail`. */
export async function signOut(fail: (message: string) => void): Promise<void> {
  try {
    await call(client.POST("/api/auth/logout", { body: {} }));
  } catch (err) {
    if (!(err instanceof ApiError && err.status === 401)) {
      fail(humanError(err));
      return;
    }
  }
  page.leaving = true;
  dropEarly();
  await forgetOffline();
  location.assign("/signin?signed_out=1");
}

/** fmtDate is a date and time in the reader's locale. */
export const fmtDate = (ms: number): string => new Date(ms).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

/** isPhone is true on a coarse pointer or a narrow screen. */
export const isPhone = (): boolean => matchMedia("(pointer: coarse), (max-width: 600px)").matches;
