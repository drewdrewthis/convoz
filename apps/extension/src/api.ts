// The Convoz web API as the panel calls it, with the browser's own session cookie. Chrome sends that SameSite=Strict cookie
// because the extension has host access to the server origin. A cookie-borne write needs X-Convoz: 1 and a JSON (or upload
// chunk) body type, and the server must list the extension's Origin (CONVOZ_EXTENSION_ORIGIN).
// Not createConvozClient (@convoz/api-client): it sends credentials "same-origin", and the panel's calls are cross-origin.
import type { ApiErrorBody } from "@convoz/api-client";
import { ApiFailure } from "./errors.ts";
import type { Identity } from "./identities.ts";
import { FORMAT } from "./message.ts";
import type { SendApi } from "./send.ts";

const CHUNK = 1024 * 1024;

/** Convoz calls one server. Every method throws ApiFailure when the server cannot be reached or answers an error. */
export class Convoz implements SendApi {
  readonly server: string;

  constructor(server: string) {
    this.server = server;
  }

  private async call<T>(method: string, path: string, init: { json?: unknown; bytes?: Blob; headers?: Record<string, string> } = {}): Promise<T> {
    const headers: Record<string, string> = { ...init.headers };
    if (method !== "GET") headers["X-Convoz"] = "1";
    if (init.json !== undefined) headers["Content-Type"] = "application/json";
    let res: Response;
    try {
      res = await fetch(this.server + path, {
        method,
        credentials: "include",
        headers,
        body: init.json !== undefined ? JSON.stringify(init.json) : init.bytes,
      });
    } catch {
      throw new ApiFailure(null);
    }
    const body: unknown = await res.json().catch(() => null);
    if (!res.ok) {
      const error = (body as ApiErrorBody | null)?.error;
      throw new ApiFailure(res.status, error?.code, error?.message);
    }
    return body as T;
  }

  /** me answers when the browser is signed in; a 401 ApiFailure when it is not. */
  me(): Promise<unknown> {
    return this.call("GET", "/api/me");
  }

  async identities(): Promise<Identity[]> {
    return (await this.call<{ identities: Identity[] }>("GET", "/api/identities")).identities;
  }

  /** createConversation makes a conversation with one agent and returns its id. */
  async createConversation(clientId: string, title: string | undefined, handle: string): Promise<number> {
    const made = await this.call<{ conversation: { id: number } }>("POST", "/api/conversations", { json: { client_id: clientId, title, participants: [handle] } });
    return made.conversation.id;
  }

  /**
   * uploadPng sends an image into a conversation (create, then chunks at the server's offset) and returns the upload id. A small
   * twin of the web app's upload loop (apps/web/src/shared/uploads.ts), without its resume and retries: a failure fails the send.
   */
  async uploadPng(conversationId: number, png: Blob): Promise<string> {
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", await png.arrayBuffer()));
    const sha256 = Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
    const made = await this.call<{ id: string; offset: number }>("POST", "/api/uploads", {
      json: { conversation_id: conversationId, kind: "image", filename: "screenshot.png", size: png.size, sha256 },
    });
    for (let offset = made.offset; ; ) {
      const state = await this.call<{ state: string; offset: number }>("PATCH", `/api/uploads/${encodeURIComponent(made.id)}`, {
        bytes: png.slice(offset, offset + CHUNK),
        headers: { "Content-Type": "application/offset+octet-stream", "Upload-Offset": String(offset) },
      });
      if (state.state === "complete") return made.id;
      // the server answered (200) yet took no bytes: stop rather than send the same chunk forever
      if (state.offset <= offset) throw new ApiFailure(200, "upload_stalled", "the screenshot upload stopped");
      offset = state.offset;
    }
  }

  /** post sends the first message of the conversation. */
  async post(conversationId: number, clientId: string, body: string, uploadIds: string[]): Promise<void> {
    await this.call("POST", `/api/conversations/${conversationId}/messages`, { json: { client_id: clientId, body, format: FORMAT, upload_ids: uploadIds } });
  }
}
