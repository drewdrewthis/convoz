// The typed fetch client of the Convoz API (paths from packages/contracts, generated into schema.ts).
import createClient, { type Client } from "openapi-fetch";
import type { paths } from "./schema.ts";

export type ConvozClient = Client<paths>;

/**
 * createConvozClient makes the same-origin client. Every request carries the JSON type and `X-Convoz: 1` (the server's CSRF
 * check needs both on every write, a DELETE with no body included) and the device cookie.
 */
export function createConvozClient(baseUrl = ""): ConvozClient {
  return createClient<paths>({
    baseUrl,
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", "X-Convoz": "1" },
    // resolved per call, so a fetch wrapped after start-up (a test guard, a service worker shim) is the one used
    fetch: (request) => globalThis.fetch(request),
  });
}

