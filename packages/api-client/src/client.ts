// The typed fetch client of the Convoz API (paths from packages/contracts, generated into schema.ts).
import createClient, { type Client } from "openapi-fetch";
import { clientIdHeaders } from "./clientIds.ts";
import type { paths } from "./schema.ts";

export type ConvozClient = Client<paths>;

/**
 * createConvozClient makes the same-origin client. Every request carries the JSON type and `X-Convoz: 1` (the server's CSRF
 * check needs both on every write, a DELETE with no body included), the device cookie, and the tab and load ids the access log
 * tells browser tabs apart by (clientIds.ts; random, never a person). `send` makes the request; the default
 * resolves the global fetch per call, so a fetch wrapped after start-up (a test guard, a service worker shim) is the one used.
 */
export function createConvozClient(baseUrl = "", send: (request: Request) => Promise<Response> = (request) => globalThis.fetch(request)): ConvozClient {
  return createClient<paths>({
    baseUrl,
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", "X-Convoz": "1", ...clientIdHeaders() },
    fetch: send,
  });
}

