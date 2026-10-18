// The answers a page load already holds before the app asks (design §12.2): on a cold page, the first screen's reads the server put
// in the document itself (<script type="application/json" id="cz-data">); on the lean shell, the head start src/early.ts asked for
// before the app loaded. Each one is handed out once, to the client's first request for the same URL, and only near the start of
// the page: a later request must see fresh data, not what the page held at load.

/** After this long the head start is over: a request this late fetches for itself. */
const FRESH_MS = 10_000;

/** The id of a cold page's data block: {"generated_at": <server ms>, "reads": {"/api/now": <its answer>, ...}}. */
const DATA_BLOCK_ID = "cz-data";

let inline: Map<string, unknown> | undefined;

/** The reads of the page's data block, by absolute URL. Read once; the lean shell has no block, so it holds none. */
function inlineReads(): Map<string, unknown> {
  if (inline) return inline;
  inline = new Map();
  // Read once, then removed: the owner's reads must not stay in the DOM for a script or extension to find.
  const element = document.getElementById(DATA_BLOCK_ID);
  const text = element?.textContent;
  element?.remove();
  try {
    const block = JSON.parse(text || "null") as { reads?: Record<string, unknown> } | null;
    for (const [path, body] of Object.entries(block?.reads ?? {})) inline.set(new URL(path, location.origin).href, body);
  } catch {
    /* a broken block only loses the head start: the client fetches for itself */
  }
  return inline;
}

const early = () => (globalThis as { convozEarly?: Map<string, Promise<Response>> }).convozEarly;

/**
 * takeEarly returns the answer this load already holds for this request, or undefined when there is none (any other request, a
 * second one for the same URL, or one made late). An inline read is answered as the server answered it (200, JSON); its use sets
 * the mark "inline-read <path>", so a trace tells a screen drawn from the document from one that waited for the network. A head
 * start that failed is tried again as a plain fetch, so a link that came back counts.
 */
export function takeEarly(request: Request): Promise<Response> | undefined {
  if (request.method !== "GET") return undefined;
  const reads = inlineReads();
  if (reads.has(request.url)) {
    const body = reads.get(request.url);
    reads.delete(request.url);
    if (performance.now() <= FRESH_MS) {
      performance.mark(`inline-read ${new URL(request.url).pathname}`);
      return Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } }));
    }
  }
  const held = early();
  const answer = held?.get(request.url);
  if (!held || !answer) return undefined;
  held.delete(request.url);
  if (performance.now() > FRESH_MS) return undefined;
  return answer.catch(() => globalThis.fetch(request));
}

/** dropEarly forgets every answer the load held: a page back from the back-forward cache, or a session that ended (401, sign-out), must ask the server again. */
export function dropEarly(): void {
  inlineReads().clear();
  early()?.clear();
}
