import http from "node:http";
import type { AddressInfo } from "node:net";
import type { ServerHandle } from "./fixtures.ts";
import { send } from "./http.ts";
import type { Owner } from "./owner.ts";
import { must } from "./owner.ts";
import { bearer } from "./machines.ts";
import { expect } from "./scenario.ts";

/**
 * Helpers for the link-unfurl scenarios of WP15 (tests/unfurl.wp15.spec.ts).
 *
 * THE ROUTE  GET /api/messages/:id/unfurl -> 200 {status:"pending"|"ok"|"unavailable", url, kind?, site?, title?, description?, meta?}.
 *   403 for anyone who cannot see the message, and for an agent that can ("agent_gets_link_only": an agent gets the address only); 404
 *   when the message has no link, or no card was queued. The card is for the FIRST link of the message.
 * THE WORKER  fetches a queued address after the post commits (about a second) and never connects to a private address.
 * TEST BUILD  POST /__test/unfurl-fixture {host, target:"127.0.0.1:port"} makes the host resolve to a made-up public address whose
 *   connections go to the fixture server; {host, resolves:"10.0.0.5"} makes the host resolve to that address only. Any other name is
 *   "no such host" (no real DNS). A literal 127.0.0.1 in a link stays refused.
 */

export interface Card {
  status: "pending" | "ok" | "unavailable";
  url: string;
  kind?: string;
  site?: string;
  title?: string;
  description?: string;
  meta?: { repo?: string; number?: number; state?: string };
}

/** What the owner is told about the card of a message. */
export function ownerCard(owner: Owner, id: number) {
  return owner.client.get(`/api/messages/${id}/unfurl`);
}

/** What an agent with this lease is told. */
export function agentCard(srv: ServerHandle, lease: string, id: number) {
  return send(srv.target, "GET", `/api/messages/${id}/unfurl`, bearer(lease));
}

/** Wait until the worker has settled the card (ok or unavailable) and return it. */
export async function settledCard(owner: Owner, id: number): Promise<Card> {
  let card: Card = { status: "pending", url: "" };
  await expect
    .poll(
      async () => {
        const res = await ownerCard(owner, id);
        if (res.status === 200) card = res.json();
        return res.status === 200 ? card.status : `HTTP ${res.status}`;
      },
      { timeout: 20_000, message: "the unfurl worker settles the card" },
    )
    .not.toMatch(/pending|HTTP/);
  return card;
}

/** A pull request as GitHub's API answers for it. */
export const PULL = { title: "Retry budget for the export worker", state: "open", merged: false, body: "Caps retries at three per export.\nSecond line." };

export interface Site {
  /** Requests the site received, as "METHOD path". */
  hits: string[];
  port: number;
  close(): Promise<void>;
}

/** A web server on 127.0.0.1 that stands for a site. `answer` writes the response; the default is a page titled by its path. */
export async function site(answer: (req: http.IncomingMessage, res: http.ServerResponse, port: number) => void, port = 0): Promise<Site> {
  const hits: string[] = [];
  const server = http.createServer((req, res) => {
    hits.push(`${req.method} ${req.url}`);
    answer(req, res, (server.address() as AddressInfo).port);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return { hits, port: (server.address() as AddressInfo).port, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

/** Make `hosts` resolve to a public-looking address served by the site. */
export async function serve(srv: ServerHandle, s: Site, ...hosts: string[]): Promise<void> {
  for (const host of hosts) must(await send(srv.target, "POST", "/__test/unfurl-fixture", { json: { host, target: `127.0.0.1:${s.port}` } }), `fixture ${host}`);
}

/** Make `host` resolve to `address` only. */
export async function resolveTo(srv: ServerHandle, host: string, address: string): Promise<void> {
  must(await send(srv.target, "POST", "/__test/unfurl-fixture", { json: { host, resolves: address } }), `resolve ${host}`);
}

/** GitHub: the page of a pull request is never fetched; its API answer is. */
export function github(): Promise<Site> {
  return site((req, res) => {
    if (req.url === "/repos/acme/app/pulls/415") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(PULL));
    } else {
      res.statusCode = 404;
      res.end("not found");
    }
  });
}
