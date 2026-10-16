import { Client, DEVICE_COOKIE, send } from "../lib/http.ts";
import { plainDb, stepped } from "../lib/machines.ts";
import { addSecondPasskey } from "../lib/mobile.ts";
import { apiServer, bootstrapOwner, must, signIn } from "../lib/owner.ts";
import { expect, scenario } from "../lib/scenario.ts";
import { SoftAuthenticator } from "../lib/soft-authenticator.ts";

// Contract for S-U0 (read with console-mobile.spec.ts):
//   GET /favicon.ico, /apple-touch-icon.png (image/png), /manifest.webmanifest (application/manifest+json): public, no cookie.
//     manifest: {name:"Convoz", start_url:"/", display:"standalone", icons:[{src,sizes,type}...] (>= 1), theme_color, background_color}.
//   Every console page's <head>: <link rel="icon">, <link rel="apple-touch-icon">, <link rel="manifest">, <meta name="theme-color">,
//     and a viewport meta that contains viewport-fit=cover.
//   GET /api/me/recovery-codes (owner device) -> 200 {remaining:N}; no cookie -> 401. POST /api/me/recovery-codes keeps S1a's contract and
//     also appends the event "recovery.regenerated.v1" ({identity_id}) next to the audit line.
//   GET /api/me/passkeys items: {id,label,registered_via,created_at,last_used_at,this_device:boolean}. this_device is true only for the
//     passkey the calling device session signed in with.
//   POST /api/auth/passkey/register/verify from a recovery (limited) device sets a FULL device cookie for the new passkey, and
//     GET /api/me carries recovery:{codes_left:N, hold_until:<ms epoch or null>} (hold_until null once the 24 h hold has passed).
//   POST /api/device/code with host_info made of < > & " \ never answers 5xx: it answers 400, or 200 with those characters stripped.

const PLAIN = { CONVOZ_TEST_PLAINTEXT: "1" };

scenario("The console serves a favicon, an apple touch icon and a manifest without a sign-in", { tag: ["@api"] }, async ({ server }) => {
  const srv = await server(apiServer());
  const stranger = new Client(srv.target);

  // When a client with no cookie asks for /favicon.ico, /apple-touch-icon.png and /manifest.webmanifest
  const favicon = await stranger.get("/favicon.ico");
  const touch = await stranger.get("/apple-touch-icon.png");
  const manifest = await stranger.get("/manifest.webmanifest");

  // Then each answers 200 with an image type for the icons and a manifest type for the manifest
  expect([favicon.status, touch.status, manifest.status]).toEqual([200, 200, 200]);
  expect(String(favicon.headers["content-type"])).toMatch(/^image\//);
  expect(String(touch.headers["content-type"])).toMatch(/^image\/png/);
  expect(String(manifest.headers["content-type"])).toMatch(/manifest\+json/);

  // And the manifest is named "Convoz", starts at "/", is standalone and lists an icon
  const doc = manifest.json();
  expect(doc).toMatchObject({ name: "Convoz", start_url: "/", display: "standalone" });
  expect(doc.icons.length).toBeGreaterThan(0);
});

scenario("Every console page links its icons, manifest and theme colour", { tag: ["@api"] }, async ({ server }) => {
  const srv = await server(apiServer());
  const stranger = new Client(srv.target);

  // When a client with no cookie asks for /signin, /recover and /bootstrap
  const pages = await Promise.all(["/signin", "/recover", "/bootstrap"].map((p) => stranger.get(p)));

  // Then each page links an icon, an apple touch icon and the manifest
  for (const p of pages) {
    expect(p.text).toMatch(/<link[^>]+rel="icon"/);
    expect(p.text).toMatch(/<link[^>]+rel="apple-touch-icon"/);
    expect(p.text).toMatch(/<link[^>]+rel="manifest"/);
  }

  // And each page has a theme-color and a viewport that covers the safe areas
  for (const p of pages) {
    expect(p.text).toMatch(/<meta[^>]+name="theme-color"/);
    expect(p.text).toMatch(/<meta[^>]+name="viewport"[^>]+viewport-fit=cover/);
  }
});

scenario("The recovery codes count answers how many codes are left", { tag: ["@api"] }, async ({ server }) => {
  // Given the owner has 10 recovery codes
  const srv = await server(apiServer());
  const owner = await bootstrapOwner(srv);
  const left = async () => must(await owner.client.get("/api/me/recovery-codes"), "recovery count").json();

  // When GET /api/me/recovery-codes is asked, after one code was used and after new codes were made
  const first = await left();
  must(await new Client(srv.target).post("/api/auth/recovery", { code: owner.codes[0]! }), "use a code");
  const second = await left();
  must(await stepped(owner, "POST", "/api/me/recovery-codes", {}, "recovery.regenerate"), "regenerate");
  const third = await left();

  // Then it answers {"remaining": 10}, then {"remaining": 9}, then {"remaining": 10}
  expect([first, second, third]).toEqual([{ remaining: 10 }, { remaining: 9 }, { remaining: 10 }]);

  // And a client with no cookie gets 401
  expect((await new Client(srv.target).get("/api/me/recovery-codes")).status).toBe(401);
});

scenario("Making new recovery codes records an event as well as the audit line", { tag: ["@api"] }, async ({ server, dataDir }) => {
  // Given the owner made new recovery codes with a passkey check
  const srv = await server(apiServer({ env: PLAIN }));
  const owner = await bootstrapOwner(srv);
  const made = must(await stepped(owner, "POST", "/api/me/recovery-codes", {}, "recovery.regenerate"), "regenerate").json().recovery_codes as string[];

  // When the stored events and the audit view are read
  const db = plainDb(dataDir);
  let events: { type: string; payload: string }[];
  try {
    events = db.prepare("SELECT type, payload_json AS payload FROM events WHERE type = 'recovery.regenerated.v1'").all() as { type: string; payload: string }[];
  } finally {
    db.close();
  }
  const audit = must(await owner.client.get("/api/admin/audit"), "audit").json().audit as { action: string }[];

  // Then both hold "recovery.regenerated" once
  expect(events).toHaveLength(1);
  expect(audit.filter((r) => r.action === "recovery.regenerated")).toHaveLength(1);

  // And neither holds a code
  const text = JSON.stringify(events) + JSON.stringify(audit);
  expect([...made, ...owner.codes].filter((c) => text.includes(c))).toEqual([]);
});

scenario("The passkeys list marks the passkey this device signed in with", { tag: ["@api"] }, async ({ server }) => {
  // Given the owner has two passkeys and two devices, each signed in with a different one
  const srv = await server(apiServer());
  const owner = await bootstrapOwner(srv);
  const second = await addSecondPasskey(srv, owner);
  const other = new Client(srv.target);
  await signIn(other, second);

  // When each device asks for GET /api/me/passkeys
  type Row = { id: number; registered_via: string; last_used_at: number | null; this_device: boolean };
  const first = must(await owner.client.get("/api/me/passkeys"), "list on first").json().passkeys as Row[];
  const seconds = must(await other.get("/api/me/passkeys"), "list on second").json().passkeys as Row[];

  // Then exactly one passkey has "this_device": true, the one that device signed in with
  expect(first.filter((p) => p.this_device).map((p) => p.registered_via)).toEqual(["bootstrap"]);
  expect(seconds.filter((p) => p.this_device).map((p) => p.registered_via)).toEqual(["session"]);

  // And each passkey carries "registered_via" and "last_used_at"
  expect([...first, ...seconds].every((p) => typeof p.registered_via === "string" && "last_used_at" in p)).toBe(true);
});

scenario("A passkey added with a recovery code starts a full device session", { tag: ["@api"] }, async ({ server }) => {
  // Given the owner used a recovery code on a new device
  const srv = await server(apiServer());
  const owner = await bootstrapOwner(srv);
  const device = new Client(srv.target);
  must(await device.post("/api/auth/recovery", { code: owner.codes[0]! }), "use recovery code");

  // When the new device registers a passkey
  const fresh = new SoftAuthenticator(srv.host, srv.origin);
  const opt = must(await device.post("/api/auth/passkey/register/options", {}), "register options").json();
  const verify = must(await device.post("/api/auth/passkey/register/verify", { ceremony_id: opt.ceremony_id, credential: fresh.create(opt.options.publicKey) }), "register verify");

  // Then the answer sets a full device cookie and the device can list passkeys
  expect(verify.setCookie.some((c) => c.startsWith(`${DEVICE_COOKIE}=`) && !/Max-Age=0/i.test(c))).toBe(true);
  expect((await device.get("/api/me/passkeys")).status).toBe(200);

  // And GET /api/me tells the codes left and the time the 24-hour hold ends
  const me = must(await device.get("/api/me"), "me").json();
  expect(me.recovery.codes_left).toBe(9);
  expect(me.recovery.hold_until).toBeGreaterThan(Date.now() + 23 * 3_600_000);
});

scenario("Host info made of markup characters never makes the server fail", { tag: ["@api"] }, async ({ server }) => {
  const srv = await server(apiServer());
  const owner = await bootstrapOwner(srv);
  const nasty = '<>&"\\'.repeat(40);

  // When POST /api/device/code is sent with a host name of 200 characters from < > & " and \
  const res = await send(srv.target, "POST", "/api/device/code", {
    json: { name: "box-9", host_info: { hostname: nasty, os: nasty, arch: nasty, cli_version: nasty } },
  });

  // Then it answers 200 or 400 and never 500
  expect([200, 400]).toContain(res.status);

  // And when it answers 200 the stored host info holds none of those characters
  if (res.status === 200) {
    const pending = must(await owner.client.get("/api/machines/requests"), "pending").json().requests as { host_info: Record<string, string> | null }[];
    const text = Object.values(pending[0]?.host_info ?? {}).join("");
    expect(text).not.toMatch(/[<>&"\\]/);
  } else {
    expect(res.json().error.code).toBeTruthy();
  }
});
