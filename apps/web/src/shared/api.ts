// The app's one way to the server: the generated client (@convoz/api-client), its answers unwrapped by `call`.
// Components never fetch; they call the store or a feature's own functions, which use `client` here.
import { createConvozClient, type ApiErrorBody } from "@convoz/api-client";
import { reachable, unreachable } from "./connection.ts";
import { dropEarly, takeEarly } from "./early.ts";
import { forgetOffline } from "./offline.ts";
import { appPath, withBase } from "./base.ts";
import { ApiError, humanError } from "./failure.ts";

export { ApiError, humanError };

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

/** The page is on its way out (a sign-in redirect or a finished flow): no more ticket fetches. `public`: no session needed. */
export const page = { leaving: false, public: false };

/** safeNext keeps a ?next= value only when it is a path on this site. */
export function safeNext(raw: string | null): string {
  return typeof raw === "string" && /^\/(?![/\\])[^\u0000-\u001f]*$/.test(raw) ? raw : "/";
}

/** toSignin sends the browser to sign in, then back to this page. A page already on its way out (sign-out) keeps its own destination. */
export function toSignin(): void {
  if (page.leaving) return;
  page.leaving = true;
  const here = location.pathname + location.search;
  location.assign(withBase(appPath() === "/" ? "/signin" : `/signin?next=${encodeURIComponent(here)}`));
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

/** signOut ends the session and opens the sign-in page. A failure is handed to `fail`. */
export async function signOut(fail: (message: string) => void): Promise<void> {
  // Set first: a read refused once the session ends must not send the page to a plain /signin that lacks "Signed out".
  page.leaving = true;
  try {
    await call(client.POST("/api/auth/logout", { body: {} }));
  } catch (err) {
    if (!(err instanceof ApiError && err.status === 401)) {
      page.leaving = false;
      fail(humanError(err));
      return;
    }
  }
  dropEarly();
  await forgetOffline();
  location.assign(withBase("/signin?signed_out=1"));
}

/** fmtDate is a date and time in the reader's locale. */
export const fmtDate = (ms: number): string => new Date(ms).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

/** isPhone is true on a coarse pointer or a narrow screen. */
export const isPhone = (): boolean => matchMedia("(pointer: coarse), (max-width: 600px)").matches;
