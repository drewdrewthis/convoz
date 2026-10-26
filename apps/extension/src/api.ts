// The Convoz web API as the panel and the worker call it, with the browser's own session cookie. Chrome sends that SameSite=Strict
// cookie because the extension has host access to the server origin. A cookie-borne write needs X-Convoz: 1 and a JSON body type,
// and the server must name the extension (CONVOZ_EXTENSION_ORIGIN): only then do the page routes exist, and they take this Origin only.
// Not createConvozClient (@convoz/api-client): it sends credentials "same-origin", and these calls are cross-origin.
import type { ApiErrorBody } from "@convoz/api-client";
import { ApiFailure } from "./errors.ts";
import type { PageRead } from "./page.ts";

/** A live share, as the server made it. */
export interface PageShare {
  id: string;
  conversation_id: number;
  tab_origin: string;
}

/** An agent's request the long poll hands over. */
export interface PageRequest {
  id: string;
  op: "read" | "shot";
}

/** The extension's answer to a request. */
export type PageResult = { ok: true; read: PageRead } | { ok: true; shot: { png_base64: string } } | { ok: false; error: string };

/** How long one poll waits on the server, in seconds (the server's most). */
const POLL_WAIT = 25;

/** Convoz calls one server. Every method throws ApiFailure when the server cannot be reached or answers an error. */
export class Convoz {
  readonly server: string;

  constructor(server: string) {
    this.server = server;
  }

  /** call returns the answer's JSON, or null for an answer with no body (204). */
  private async call<T>(method: string, path: string, init: { json?: unknown; signal?: AbortSignal } = {}): Promise<T | null> {
    const headers: Record<string, string> = {};
    let body: string | undefined;
    if (method !== "GET") {
      headers["X-Convoz"] = "1";
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(init.json ?? {});
    }
    let res: Response;
    try {
      res = await fetch(this.server + path, { method, credentials: "include", headers, body, signal: init.signal });
    } catch (err) {
      if (init.signal?.aborted) throw err;
      throw new ApiFailure(null);
    }
    const answer: unknown = await res.json().catch(() => null);
    if (!res.ok) {
      const error = (answer as ApiErrorBody | null)?.error;
      throw new ApiFailure(res.status, error?.code, error?.message);
    }
    return answer as T | null;
  }

  /** me answers when the browser is signed in; a 401 ApiFailure when it is not. */
  async me(): Promise<void> {
    await this.call("GET", "/api/me");
  }

  /** conversation is the title of a conversation and the handles of its participants. */
  async conversation(id: number): Promise<{ title: string; handles: string[] }> {
    const got = await this.call<{ conversation: { title: string | null; participants: { handle: string }[] } }>("GET", `/api/conversations/${id}`);
    return { title: got?.conversation.title ?? "", handles: got?.conversation.participants.map((p) => p.handle) ?? [] };
  }

  /** startShare shares a tab of origin with a conversation; it ends that conversation's older share. */
  async startShare(conversation: number, origin: string): Promise<PageShare> {
    const made = await this.call<{ share: PageShare }>("POST", "/api/page/shares", { json: { conversation_id: conversation, tab_origin: origin } });
    return made!.share;
  }

  stopShare(id: string): Promise<unknown> {
    return this.call("DELETE", `/api/page/shares/${encodeURIComponent(id)}`);
  }

  /** next waits for an agent's request: null when none came; a 404 ApiFailure once the share ended. */
  async next(share: string, signal: AbortSignal): Promise<PageRequest | null> {
    const got = await this.call<{ request: PageRequest }>("GET", `/api/page/shares/${encodeURIComponent(share)}/next?wait=${POLL_WAIT}`, { signal });
    return got?.request ?? null;
  }

  async answer(request: string, result: PageResult): Promise<void> {
    await this.call("POST", `/api/page/requests/${encodeURIComponent(request)}/result`, { json: result });
  }
}
