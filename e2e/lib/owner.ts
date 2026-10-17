import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type { Page } from "@playwright/test";
import { makeBootstrapLink, type BootstrapLink } from "./admin.ts";
import type { ServerHandle, ServerOptions } from "./fixtures.ts";
import { Client, type Res } from "./http.ts";
import { SoftAuthenticator } from "./soft-authenticator.ts";

/** The tailnet name API scenarios serve under. Origin is `https://convoz.testonly.ts.net`. */
export const API_HOST = "convoz.testonly.ts.net";

/** Options for a server API scenarios talk to: tailnet name and an admin socket. */
export const apiServer = (o: ServerOptions = {}): ServerOptions => ({ host: API_HOST, adminSocket: true, ...o });

/** A fresh scratch dir (the OS reaps it). */
export const tmpDir = (prefix = "convoz-s1a-"): string => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

/** A free loopback TCP port (small race window; fine for a test that starts one server). */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

export function must(res: Res, what: string, status = 200): Res {
  if (res.status !== status) throw new Error(`${what}: expected HTTP ${status}, got ${res.status} ${res.text}`);
  return res;
}

export interface Owner {
  client: Client;
  soft: SoftAuthenticator;
  link: BootstrapLink;
  /** The 10 recovery codes the first bootstrap returned (empty for a later bootstrap). */
  codes: string[];
  verify: Res;
}

/**
 * Register a passkey from a bootstrap link, over the real HTTP ceremony with the soft authenticator.
 * Contract: POST /api/auth/bootstrap/options {token, handle?, display_name?} -> {ceremony_id, options:{publicKey}};
 * POST /api/auth/bootstrap/verify {ceremony_id, credential} -> {owner:{id,handle,display_name}, recovery_codes?:[10]}
 * and a device cookie. `handle` and `display_name` are needed for the first owner; once an owner exists they are ignored.
 */
export async function bootstrapOwner(
  srv: ServerHandle,
  o: { handle?: string; displayName?: string; client?: Client; soft?: SoftAuthenticator; link?: BootstrapLink } = {},
): Promise<Owner> {
  if (!srv.adminSocket) throw new Error("bootstrapOwner: server has no admin socket");
  const link = o.link ?? (await makeBootstrapLink(srv.adminSocket));
  const client = o.client ?? new Client(srv.target);
  const soft = o.soft ?? new SoftAuthenticator(srv.host, srv.origin);
  const opt = must(
    await client.post("/api/auth/bootstrap/options", { token: link.token, handle: o.handle ?? "drew", display_name: o.displayName ?? "Drew" }),
    "bootstrap options",
  ).json();
  const credential = soft.create(opt.options.publicKey);
  const verify = must(await client.post("/api/auth/bootstrap/verify", { ceremony_id: opt.ceremony_id, credential }), "bootstrap verify");
  return { client, soft, link, codes: verify.json().recovery_codes ?? [], verify };
}

/** Sign in with a passkey: POST /api/auth/passkey/login/{options,verify}; sets the device cookie in `client`. */
export async function signIn(client: Client, soft: SoftAuthenticator): Promise<Res> {
  const opt = must(await client.post("/api/auth/passkey/login/options", {}), "login options").json();
  const credential = soft.get(opt.options.publicKey);
  return must(await client.post("/api/auth/passkey/login/verify", { ceremony_id: opt.ceremony_id, credential }), "login verify");
}

/**
 * Console page contract used by @browser scenarios (role and text locators only):
 *  /signin     button "Sign in with a passkey"; on success the browser lands on "/chats" (heading "Chats"). This helper then
 *              opens "/" so the scenarios that work from Now keep their start. Scenarios about the landing page sign in by hand.
 *  /           heading "Now" (signed in). Signed out, the page goes to /signin.
 *  /signin     heading "Sign in".
 */
export async function uiSignIn(page: Page, origin: string): Promise<void> {
  await page.goto(`${origin}/signin`);
  await page.getByRole("button", { name: "Sign in with a passkey" }).click();
  await page.getByRole("navigation", { name: "Main" }).waitFor();
  await page.goto(`${origin}/`);
  await page.getByRole("heading", { name: "Now", exact: true }).waitFor();
}
