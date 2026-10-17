// The answers src/early.ts asked for before the app loaded. Each one is handed out once, to the client's first request for the
// same URL, and only near the start of the page: a later request must see fresh data, not what the page asked for at load.

/** After this long the head start is over: a request this late fetches for itself. */
const FRESH_MS = 10_000;

/**
 * takeEarly returns the head-start answer to this request, or undefined when there is none (any other request, a second one for
 * the same URL, or one made late). A head start that failed is tried again as a plain fetch, so a link that came back counts.
 */
export function takeEarly(request: Request): Promise<Response> | undefined {
  const held = (globalThis as { convozEarly?: Map<string, Promise<Response>> }).convozEarly;
  if (!held || request.method !== "GET") return undefined;
  const answer = held.get(request.url);
  if (!answer) return undefined;
  held.delete(request.url);
  if (performance.now() > FRESH_MS) return undefined;
  return answer.catch(() => globalThis.fetch(request));
}
