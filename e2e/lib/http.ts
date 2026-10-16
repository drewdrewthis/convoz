import http from "node:http";
import { record } from "./transcript.ts";

/**
 * HTTP over node:http so a test can set Host and X-Forwarded-* by hand and can talk to a
 * unix socket. A real browser or fetch cannot do either.
 */

export interface Target {
  /** TCP port on 127.0.0.1; or */
  tcpPort?: number;
  /** a unix socket path (the listener behind `tailscale serve`). */
  unixPath?: string;
  /** The name passed as `--host`. */
  host: string;
  /** The exact Origin a browser would send. */
  origin: string;
}

export interface Res {
  status: number;
  headers: http.IncomingHttpHeaders;
  setCookie: string[];
  text: string;
  json<T = any>(): T;
}

export interface ReqOpts {
  /** JSON body (sets Content-Type). */
  json?: unknown;
  /** Raw body. */
  body?: string;
  headers?: Record<string, string>;
  /** Browser-write headers: `Origin` = target.origin, `X-Convoz: 1`, JSON content type (body `{}` if none). */
  csrf?: boolean;
  /** Override the Origin that `csrf` sends; `null` sends none. */
  origin?: string | null;
  /** Leave `X-Convoz` out although `csrf` is set. */
  noConvozHeader?: boolean;
  /** Override Host. TCP default `<host>:<port>`; unix default `localhost`. */
  hostHeader?: string;
  /** Unix only: override or (null) drop `X-Forwarded-Host`. Default: the `--host` name. */
  forwardedHost?: string | null;
  /** Explicit Cookie header; `null` sends none even if the jar has one. */
  cookie?: string | null;
  timeoutMs?: number;
}

/** One request, no state. */
export function send(target: Target, method: string, path: string, o: ReqOpts = {}): Promise<Res> {
  const headers: Record<string, string> = {};
  const unix = target.unixPath !== undefined;
  headers["Host"] = o.hostHeader ?? (unix ? "localhost" : `${target.host}:${target.tcpPort}`);
  if (unix && o.forwardedHost !== null) headers["X-Forwarded-Host"] = o.forwardedHost ?? target.host;
  let body = o.body;
  if (o.json !== undefined) body = JSON.stringify(o.json);
  if (o.csrf) {
    if (o.origin !== null) headers["Origin"] = o.origin ?? target.origin;
    if (!o.noConvozHeader) headers["X-Convoz"] = "1";
    if (body === undefined && method !== "GET") body = "{}";
  }
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    headers["Content-Length"] = String(Buffer.byteLength(body));
  }
  Object.assign(headers, o.headers ?? {});
  if (o.cookie) headers["Cookie"] = o.cookie;

  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        method,
        path,
        headers,
        agent: false,
        ...(unix ? { socketPath: target.unixPath } : { host: "127.0.0.1", port: target.tcpPort }),
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          const out: Res = {
            status: res.statusCode ?? 0,
            headers: res.headers,
            setCookie: res.headers["set-cookie"] ?? [],
            text,
            json: <T>() => JSON.parse(text) as T,
          };
          record(`HTTP ${method} ${path}${body === undefined ? "" : " " + body}`, text, "", `status=${out.status}`);
          resolve(out);
        });
        res.on("error", reject);
      },
    );
    req.setTimeout(o.timeoutMs ?? 10_000, () => req.destroy(new Error(`${method} ${path}: no answer in ${o.timeoutMs ?? 10_000} ms`)));
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

/** A client with a cookie jar for one device. */
export class Client {
  readonly jar = new Map<string, string>();
  readonly target: Target;

  constructor(target: Target) {
    this.target = target;
  }

  /** `name=value; ...` of the jar. */
  cookieHeader(): string {
    return [...this.jar].map(([k, v]) => `${k}=${v}`).join("; ");
  }

  async request(method: string, path: string, o: ReqOpts = {}): Promise<Res> {
    const cookie = o.cookie === undefined ? this.cookieHeader() || null : o.cookie;
    const res = await send(this.target, method, path, { ...o, cookie });
    for (const line of res.setCookie) {
      const [pair = "", ...attrs] = line.split(";").map((s) => s.trim());
      const eq = pair.indexOf("=");
      const name = pair.slice(0, eq);
      const value = pair.slice(eq + 1);
      const maxAge = attrs.find((a) => /^max-age=/i.test(a));
      if (value === "" || (maxAge && Number(maxAge.split("=")[1]) <= 0)) this.jar.delete(name);
      else this.jar.set(name, value);
    }
    return res;
  }

  get(path: string, o: ReqOpts = {}): Promise<Res> {
    return this.request("GET", path, o);
  }
  /** A browser-style write: exact Origin, `X-Convoz: 1`, JSON. */
  post(path: string, json: unknown = {}, o: ReqOpts = {}): Promise<Res> {
    return this.request("POST", path, { csrf: true, json, ...o });
  }
  del(path: string, o: ReqOpts = {}): Promise<Res> {
    return this.request("DELETE", path, { csrf: true, ...o });
  }
}

export const DEVICE_COOKIE = "__Host-convoz_sid";
