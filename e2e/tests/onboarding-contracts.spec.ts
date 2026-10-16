import { DEVICE_COOKIE, Client, send } from "../lib/http.ts";
import { apiServer, bootstrapOwner, must } from "../lib/owner.ts";
import { expect, scenario } from "../lib/scenario.ts";
import { SoftAuthenticator } from "../lib/soft-authenticator.ts";
import { webauthn } from "../lib/webauthn-browser.ts";

interface RouteRow {
  method: string;
  pattern: string;
}

scenario("No HTTP route can make a bootstrap link", { tag: ["@api"] }, async ({ server }) => {
  const srv = await server(apiServer());
  const owner = await bootstrapOwner(srv);

  // When every route in the API contract is called with the owner's cookie
  // (GET /__test/routes lists the route table: {"routes":[{"method","pattern","auth"}...]}, patterns use :name)
  const listed = must(await send(srv.target, "GET", "/__test/routes"), "routes").json<{ routes: RouteRow[] }>().routes;
  const weight = (r: RouteRow) => (r.pattern === "/api/auth/logout" ? 2 : r.method === "DELETE" ? 1 : 0);
  const routes = [...listed].sort((a, b) => weight(a) - weight(b));
  const bodies: string[] = [];
  for (const r of routes) {
    const res = await owner.client.request(r.method, r.pattern.replace(/:[A-Za-z_]+/g, "1"), {
      csrf: r.method !== "GET",
      ...(r.method === "GET" || r.method === "DELETE" ? {} : { json: {} }),
    });
    bodies.push(res.text, JSON.stringify(res.headers));
  }
  // The admin route is not on the HTTP listener at all
  const admin = await owner.client.post("/admin/bootstrap-link", {});
  bodies.push(admin.text, JSON.stringify(admin.headers));

  // Then none of them returns a "cvz_b_" token
  expect(listed.length).toBeGreaterThanOrEqual(20);
  expect(listed.some((r) => r.method === "POST" && r.pattern === "/api/auth/logout")).toBe(true);
  expect(listed.some((r) => /bootstrap-link/.test(r.pattern))).toBe(false);
  expect(admin.status).toBe(404);
  expect(bodies.filter((b) => b.includes("cvz_b_"))).toEqual([]);
});

scenario("There is only ever one owner", { tag: ["@api"] }, async ({ server }) => {
  // Given the owner "drew" exists
  const srv = await server(apiServer());
  await bootstrapOwner(srv, { handle: "drew" });

  // When a second bootstrap link registers a passkey (the page asks for another handle; the server ignores it)
  const second = await bootstrapOwner(srv, {
    handle: "mallory",
    client: new Client(srv.target),
    soft: new SoftAuthenticator(srv.host, srv.origin),
  });

  // Then the passkey belongs to "drew", and GET /api/identities lists one owner
  expect(second.verify.json().owner.handle).toBe("drew");
  expect(second.codes).toEqual([]);
  const passkeys = must(await second.client.get("/api/me/passkeys"), "passkeys").json().passkeys;
  expect(passkeys).toHaveLength(2);
  const identities = must(await second.client.get("/api/identities"), "identities").json().identities as { handle: string; role: string }[];
  expect(identities.filter((i) => i.role === "owner").map((i) => i.handle)).toEqual(["drew"]);
  expect(identities).toHaveLength(1);
});

scenario("Recovery attempts are limited for everyone", { tag: ["@api"] }, async ({ server, testApi }) => {
  // The server sits behind `tailscale serve` (unix listener), where X-Forwarded-For tells the sources apart
  const srv = await server(apiServer({ listen: "unix" }));
  const owner = await bootstrapOwner(srv);
  const correct = owner.codes[0]!;

  // Given 10 wrong recovery codes were posted in the last hour from different devices
  const wrong: string[] = [];
  for (let i = 1; i <= 10; i++) {
    const res = await new Client(srv.target).post("/api/auth/recovery", { code: `TESTONLY-wrong-${i}` }, { headers: { "X-Forwarded-For": `198.51.100.${i}` } });
    expect(res.status).toBe(401);
    wrong.push(res.text);
  }

  // When a correct code is posted (from an eleventh source)
  const blocked = await new Client(srv.target).post("/api/auth/recovery", { code: correct }, { headers: { "X-Forwarded-For": "198.51.100.99" } });

  // Then the server answers 401 with the same body as a wrong code
  expect(blocked.status).toBe(401);
  expect(new Set(wrong).size).toBe(1);
  expect(blocked.text).toBe(wrong[0]);

  // And the limit is for the last hour: the same code works once those attempts are older than that
  await testApi(srv).advanceClock(3_601_000);
  const later = await new Client(srv.target).post("/api/auth/recovery", { code: correct }, { headers: { "X-Forwarded-For": "198.51.100.99" } });
  expect(later.status).toBe(200);
});

scenario("Sign in sets a strict device cookie", { tag: ["@browser"] }, async ({ server, page, context }) => {
  // Given owner "drew" has a passkey
  const srv = await server({ host: "localhost", adminSocket: true });
  const owner = await bootstrapOwner(srv);
  const wa = await webauthn(context, page);
  await (await wa.add()).addCredential(owner.soft.exportForChromium());

  // When the owner signs in with the passkey
  await page.goto(`${srv.origin}/signin`);
  const verified = page.waitForResponse((r) => r.url().endsWith("/api/auth/passkey/login/verify") && r.request().method() === "POST");
  await page.getByRole("button", { name: "Sign in with a passkey" }).click();
  const response = await verified;

  // Then the response sets "__Host-convoz_sid" with Secure, HttpOnly and SameSite=Strict (Path=/, Max-Age 30 days, no Domain, no Expires)
  expect(response.status()).toBe(200);
  const line = (await response.headerValues("set-cookie")).find((v) => v.startsWith(`${DEVICE_COOKIE}=`)) ?? "";
  expect(line).toMatch(/;\s*Secure\b/i);
  expect(line).toMatch(/;\s*HttpOnly\b/i);
  expect(line).toMatch(/;\s*SameSite=Strict\b/i);
  expect(line).toMatch(/;\s*Path=\/(;|$)/i);
  expect(line).toMatch(/;\s*Max-Age=2592000(;|$)/i);
  expect(line).not.toMatch(/;\s*Domain=/i);
  expect(line).not.toMatch(/;\s*Expires=/i);

  // And the cookie value is not the passkey id
  const value = line.split(";")[0]!.slice(DEVICE_COOKIE.length + 1);
  expect(value).toMatch(/^cvz_d_/);
  expect(value).not.toContain(owner.soft.lastCredentialId);
  // Sign-in lands on Chats (console-mobile contract), not Now
  await page.getByRole("heading", { name: "Chats", exact: true }).waitFor();
  expect((await context.cookies()).find((c) => c.name === DEVICE_COOKIE)?.sameSite).toBe("Strict");
});

scenario("Logout revokes the device and clears site data", { tag: ["@api"] }, async ({ server }) => {
  const srv = await server(apiServer());
  const owner = await bootstrapOwner(srv);
  const oldCookie = owner.client.cookieHeader();
  expect((await owner.client.get("/api/me")).status).toBe(200);

  // When the owner calls POST /api/auth/logout
  const out = await owner.client.post("/api/auth/logout", {});

  // Then the response carries "Clear-Site-Data" (204, cookie expired)
  expect(out.status).toBe(204);
  expect(out.headers["clear-site-data"]).toBe('"cache","cookies","storage"');
  expect(out.setCookie.some((c) => c.startsWith(`${DEVICE_COOKIE}=`) && /Max-Age=0/i.test(c))).toBe(true);

  // And the old device cookie answers 401
  const after = await new Client(srv.target).get("/api/me", { cookie: oldCookie });
  expect(after.status).toBe(401);
});
