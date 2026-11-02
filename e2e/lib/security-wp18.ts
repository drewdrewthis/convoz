import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import yaml from "js-yaml";
import type { ServerHandle } from "./fixtures.ts";
import { send, type Res } from "./http.ts";
import { DEVICE_COOKIE } from "./http.ts";
import { repoRoot } from "./paths.ts";

/**
 * Helpers of the security matrix (WP18, tests/security.wp18.spec.ts). The matrix compares three things for every route:
 *   - the OpenAPI contract: packages/contracts/paths/*.yaml, where each operation carries
 *       x-authz: { auth: pub|human|limited|owner|machine|lease, lease?: accept|refuse, scope?: <lease scope>, step_up?: <action> }
 *     auth     the credential class (human = a device session; limited = also a recovery session; owner = the owner's device session;
 *              machine = a machine key; lease = an agent session lease; pub = none);
 *     lease    on a person's route: accept = a lease also meets it, refuse = a lease is told 403, absent = a lease is told 401;
 *     scope    the scope a lease needs (a lease without it is told 403);
 *   - the live route table: GET /__test/routes of the testhooks build;
 *   - what the server answers to each credential.
 */

export type AuthClass = "pub" | "human" | "limited" | "owner" | "machine" | "lease";

export interface Authz {
  auth: AuthClass;
  lease?: "accept" | "refuse";
  scope?: string;
  step_up?: string;
}

export interface ContractOp {
  method: string;
  /** As the contract writes it: `/api/messages/{id}`. */
  path: string;
  operationId: string;
  authz?: Authz;
  security?: Record<string, unknown>[];
  /** The operation lists the X-Convoz-Step-Up header. */
  stepUpHeader: boolean;
}

export interface LiveRoute {
  method: string;
  pattern: string;
  auth: "pub" | "H" | "H/L" | "O" | "M" | "L";
  lease: boolean;
  refuse_lease: boolean;
  scope: string;
  step_up: string;
  page: boolean;
  /** A refused caller is told 404, as for an unknown path (the owner's /dev copy). */
  hidden: boolean;
}

const METHODS = ["get", "post", "put", "patch", "delete", "head"];
const contractDir = path.join(repoRoot, "packages", "contracts");

/** Every operation of the contract, read from the module files, and the paths the root openapi.yaml lists. */
export function loadContract(): { ops: ContractOp[]; listedPaths: string[] } {
  const root = yaml.load(fs.readFileSync(path.join(contractDir, "openapi.yaml"), "utf8")) as { paths: Record<string, unknown> };
  const ops: ContractOp[] = [];
  for (const file of fs.readdirSync(path.join(contractDir, "paths")).sort()) {
    const items = yaml.load(fs.readFileSync(path.join(contractDir, "paths", file), "utf8")) as Record<string, Record<string, any>>;
    for (const [p, item] of Object.entries(items ?? {})) {
      for (const m of METHODS) {
        const op = item?.[m];
        if (!op) continue;
        ops.push({
          method: m.toUpperCase(),
          path: p,
          operationId: op.operationId ?? "",
          authz: op["x-authz"],
          security: op.security,
          stepUpHeader: ((op.parameters ?? []) as { $ref?: string }[]).some((x) => /\/StepUp(Optional)?$/.test(x.$ref ?? "")),
        });
      }
    }
  }
  return { ops, listedPaths: Object.keys(root.paths) };
}

/** `GET /__test/routes`. */
export async function liveRoutes(srv: ServerHandle): Promise<LiveRoute[]> {
  const res = await send(srv.target, "GET", "/__test/routes");
  if (res.status !== 200) throw new Error(`GET /__test/routes: ${res.status} ${res.text}`);
  return res.json().routes as LiveRoute[];
}

/** `{id}` and `:id` both become `:x`, so a contract path and a route pattern compare. */
export const normalize = (p: string): string => p.replace(/\{[^}]*\}|:[A-Za-z_]+/g, ":x");

/** A path to call: every parameter is an id nothing has, so a probe that gets past the credential finds nothing to change. */
export const concrete = (p: string): string => p.replace(/\{public_id\}|:public_id/, "f_TESTONLY").replace(/\{[^}]*\}|:[A-Za-z_]+/g, "999999");

/** The auth class a live route row stands for, in the contract's words. */
export const CLASS_OF_LIVE: Record<LiveRoute["auth"], AuthClass> = { pub: "pub", H: "human", "H/L": "limited", O: "owner", M: "machine", L: "lease" };

/** What a live row says, as the contract would write it. */
export function authzOfLive(r: LiveRoute): Authz {
  return {
    auth: CLASS_OF_LIVE[r.auth],
    ...(r.refuse_lease ? { lease: "refuse" as const } : r.lease ? { lease: "accept" as const } : {}),
    ...(r.scope ? { scope: r.scope } : {}),
    ...(r.step_up ? { step_up: r.step_up } : {}),
  };
}

export const isApi = (p: string): boolean => p.startsWith("/api/") || p === "/healthz" || p === "/install" || p.startsWith("/cli/");

/** The words of the refusal a route gives a lease it never lets in (route() in httpapi/route.go). */
export const LEASE_REFUSED = "An agent credential cannot do this.";

/** One request with the credential given as headers. Writes carry the headers a browser sends, so the CSRF wall is not what answers. */
export function call(srv: ServerHandle, method: string, route: string, cred: { cookie?: string; bearer?: string } = {}, extra: { headers?: Record<string, string> } = {}): Promise<Res> {
  const write = method !== "GET" && method !== "HEAD";
  return send(srv.target, method, route, {
    ...(write ? { json: {} } : {}),
    ...(cred.bearer ? {} : write ? { csrf: true } : {}),
    ...(cred.cookie ? { cookie: cred.cookie } : {}),
    headers: { ...(cred.bearer ? { Authorization: `Bearer ${cred.bearer}` } : {}), ...(extra.headers ?? {}) },
    timeoutMs: 5_000,
  });
}

const errorOf = (res: Res): { code?: string; message?: string } => {
  try {
    return (res.json().error ?? {}) as { code?: string; message?: string };
  } catch {
    return {};
  }
};
export const codeOf = (res: Res): string | undefined => errorOf(res).code;
export const messageOf = (res: Res): string | undefined => errorOf(res).message;

// ---- a member: a person who is not the owner ----------------------------------------------------------

/**
 * A signed-in device of a human with the role "member". v1 has no route that makes one (members ship with invites, S-15), so the
 * row goes straight into the data file of the encryption-off build, as seedDb does for rows the API cannot make yet.
 * Returns the cookie header of a fresh device; call it again for another device of the same member.
 */
export function memberDevice(db: DatabaseSync, handle = "mia"): string {
  const now = Date.now();
  const row = db.prepare("SELECT id FROM identities WHERE handle = ?").get(handle) as { id: number } | undefined;
  let id = row?.id;
  if (id === undefined) {
    id = Number(
      db
        .prepare("INSERT INTO identities (kind, handle, display_name, display_skeleton, avatar_letter, avatar_palette, created_at) VALUES ('human', ?, ?, ?, 'M', 0, ?)")
        .run(handle, "Mia", handle, now).lastInsertRowid,
    );
    db.prepare("INSERT INTO humans (identity_id, role, created_via) VALUES (?, 'member', 'invite')").run(id);
  }
  const token = randomBytes(32).toString("base64url");
  db.prepare(
    "INSERT INTO devices (human_id, token_hash, label, created_at, last_seen_at, expires_at, absolute_expires_at) VALUES (?, ?, 'TESTONLY member', ?, ?, ?, ?)",
  ).run(id, createHash("sha256").update(token).digest(), now, now, now + 30 * 86_400_000, now + 90 * 86_400_000);
  return `${DEVICE_COOKIE}=${token}`;
}
