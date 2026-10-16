import { send, type Res, type ReqOpts } from "./http.ts";

/**
 * Client for the admin socket (`--admin-socket`): HTTP/1.1 over a unix socket, JSON in and out.
 * Contract (S1a): `POST /admin/bootstrap-link` with body `{}` answers 200
 * `{"token":"cvz_b_...","url":"<origin>/bootstrap#<token>","expires_at":"<RFC 3339>"}`.
 * Any other path answers 404 `{"error":{"code":"not_found","message":"..."}}`.
 * The same route is not served on the HTTP listener (404 there).
 */
export function adminRequest(socketPath: string, method: string, path: string, json?: unknown, o: ReqOpts = {}): Promise<Res> {
  return send({ unixPath: socketPath, host: "localhost", origin: "http://localhost" }, method, path, {
    hostHeader: "localhost",
    forwardedHost: null,
    ...(json === undefined ? {} : { json }),
    ...o,
  });
}

export interface BootstrapLink {
  token: string;
  url: string;
  expires_at: string;
}

/** Make a one-time bootstrap link, the way `convoz admin bootstrap-link` does. */
export async function makeBootstrapLink(socketPath: string): Promise<BootstrapLink> {
  const res = await adminRequest(socketPath, "POST", "/admin/bootstrap-link", {});
  if (res.status !== 200) throw new Error(`admin bootstrap-link: HTTP ${res.status} ${res.text}`);
  return res.json<BootstrapLink>();
}
