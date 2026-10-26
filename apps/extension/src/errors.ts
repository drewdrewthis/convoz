/** ApiFailure is a call to the server that did not succeed: no answer at all, or an error answer ({error:{code,message}}). */
export class ApiFailure extends Error {
  readonly status: number | null;
  readonly code: string | undefined;

  /** status null: the request never got an answer (server down, wrong address, no host access). */
  constructor(status: number | null, code?: string, message?: string) {
    super(message ?? (status === null ? "no answer" : `HTTP ${status}`));
    this.status = status;
    this.code = code;
  }
}

// every line the panel shows is a sentence
const sentence = (text: string) => (/[.!?]$/.test(text) ? text : text + ".");

/**
 * describe says in plain words what went wrong, for the panel, as a sentence. `action` names what failed ("Sharing", "Loading").
 * Anything that is not a server failure shows its own message.
 */
export function describe(err: unknown, server: string, action = "Sharing"): string {
  if (!(err instanceof ApiFailure)) return sentence(err instanceof Error ? err.message : String(err));
  if (err.status === null) return `Cannot reach ${server}.`;
  if (err.status === 401) return "Signed out. Sign in to Convoz again.";
  // only the CSRF refusal means the server does not know the extension; another 403 says its own reason
  if (err.status === 403 && err.code === "csrf") return "Not allowed (403): set CONVOZ_EXTENSION_ORIGIN on the server.";
  return sentence(`${action} failed: ${err.message}`);
}
