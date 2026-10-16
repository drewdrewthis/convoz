import { makeBootstrapLink } from "../lib/admin.ts";
import { Client, DEVICE_COOKIE } from "../lib/http.ts";
import { API_HOST, apiServer, bootstrapOwner, must, signIn, tmpDir, uiSignIn } from "../lib/owner.ts";
import { expect, scenario } from "../lib/scenario.ts";
import { webauthn } from "../lib/webauthn-browser.ts";

const DAY = 86_400_000;

// Console pages these scenarios drive (role and text locators, so the S-U screens can pass the same bindings):
//   /bootstrap#cvz_b_...  textbox "Handle", textbox "Display name", button "Register passkey"; errors in role=alert
//   after "Register passkey" (S-U0 order: codes first, then the second way in, see console-mobile.spec.ts)
//                         heading "Save your recovery codes" (step 2 of 3): list "Recovery codes" (10 items), button "Copy codes",
//                         button "Download codes", checkbox "I saved them", button "Continue" (disabled until the box is ticked)
//   /onboarding           heading "Set up a second way in" (step 3 of 3), text "Add a passkey on another device or a hardware key",
//                         button "Add a passkey", button "Skip for now" (goes to Now)
//   /                     heading "Now"
//   /signin               heading "Sign in", button "Sign in with a passkey"
//   /settings/passkeys    heading "Passkeys", one listitem per passkey with button "Remove passkey", button "Add a passkey",
//                         refusal text "Another passkey must be added first." in role=alert

scenario("A bootstrap link registers the first passkey and makes the owner", { tag: ["@cli", "@browser"] }, async ({ server, convoz, page, context }) => {
  // When "convoz admin bootstrap-link" runs on the server box (a server named like the tailnet name)
  const tailnet = await server(apiServer({ dataDir: tmpDir() }));
  const cli = await convoz(["admin", "bootstrap-link", "--admin-socket", tailnet.adminSocket!]);

  // Then it prints a link of the form "https://convoz.<tailnet>.ts.net/bootstrap#cvz_b_…"
  expect(cli.code, cli.stderr).toBe(0);
  expect(cli.stdout.trim()).toMatch(/^https:\/\/convoz\.[a-z0-9-]+\.ts\.net\/bootstrap#cvz_b_\S+$/);
  expect(cli.stdout.trim().startsWith(`https://${API_HOST}/bootstrap#`)).toBe(true);

  // And opening the link registers a virtual passkey for owner "drew" (a browser cannot reach a tailnet name, so it uses a localhost server)
  const local = await server({ host: "localhost", adminSocket: true, dataDir: tmpDir() });
  const link = await convoz(["admin", "bootstrap-link", "--admin-socket", local.adminSocket!]);
  expect(link.code, link.stderr).toBe(0);
  expect(link.stdout.trim().startsWith(`${local.origin}/bootstrap#cvz_b_`)).toBe(true);
  const wa = await webauthn(context, page);
  const device = await wa.add();
  await page.goto(link.stdout.trim());
  await page.getByRole("textbox", { name: "Handle" }).fill("drew");
  await page.getByRole("textbox", { name: "Display name" }).fill("Drew");
  await page.getByRole("button", { name: "Register passkey" }).click();
  await expect(page.getByRole("heading", { name: "Save your recovery codes" })).toBeVisible();
  expect(await device.credentials()).toHaveLength(1);

  // And the owner saves the recovery codes and skips the second passkey for now
  await page.getByRole("checkbox", { name: "I saved them" }).check();
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("heading", { name: "Set up a second way in" })).toBeVisible();
  await page.getByRole("button", { name: "Skip for now" }).click();

  // And the app shows Now
  await expect(page.getByRole("heading", { name: "Now", exact: true })).toBeVisible();
  const me = await page.request.get(`${local.origin}/api/me`);
  expect(me.status()).toBe(200);
  expect((await me.json()).identity.handle).toBe("drew");
});

scenario("A bootstrap link works once", { tag: ["@api"] }, async ({ server }) => {
  // Given a bootstrap link was used to register a passkey
  const srv = await server(apiServer());
  const owner = await bootstrapOwner(srv);

  // When the link is opened again
  const again = await new Client(srv.target).post("/api/auth/bootstrap/options", { token: owner.link.token });

  // Then the page says the link was already used (410 bootstrap_used) and registers nothing
  expect(again.status).toBe(410);
  expect(again.json().error.code).toBe("bootstrap_used");
  expect(again.setCookie).toEqual([]);
  const passkeys = must(await owner.client.get("/api/me/passkeys"), "list passkeys").json().passkeys;
  expect(passkeys).toHaveLength(1);
});

scenario("A bootstrap link expires after 10 minutes", { tag: ["@api"] }, async ({ server, testApi }) => {
  const srv = await server(apiServer());
  const clock = testApi(srv);
  const stranger = new Client(srv.target);

  // Given a bootstrap link made 10 minutes and 1 second ago (it still works at 9 minutes 59 seconds)
  const link = await makeBootstrapLink(srv.adminSocket!);
  await clock.advanceClock(599_000);
  const early = await stranger.post("/api/auth/bootstrap/options", { token: link.token, handle: "drew", display_name: "Drew" });
  expect(early.status).toBe(200);
  await clock.advanceClock(2_000);

  // When the link is opened
  const late = await stranger.post("/api/auth/bootstrap/options", { token: link.token, handle: "drew", display_name: "Drew" });

  // Then the page says the link expired (410 bootstrap_expired) and registers nothing
  expect(late.status).toBe(410);
  expect(late.json().error.code).toBe("bootstrap_expired");
  expect(late.setCookie).toEqual([]);
  const fresh = await bootstrapOwner(srv, { client: new Client(srv.target) });
  expect(fresh.codes).toHaveLength(10);
});

scenario("Onboarding asks for a second passkey and shows recovery codes once", { tag: ["@browser"] }, async ({ server, page, context }) => {
  // Given the owner registered the first passkey
  const srv = await server({ host: "localhost", adminSocket: true });
  const link = await makeBootstrapLink(srv.adminSocket!);
  const wa = await webauthn(context, page);
  await wa.add();
  await page.goto(`${srv.origin}/bootstrap#${link.token}`);
  await page.getByRole("textbox", { name: "Handle" }).fill("drew");
  await page.getByRole("textbox", { name: "Display name" }).fill("Drew");
  await page.getByRole("button", { name: "Register passkey" }).click();

  // When onboarding continues, Then it first shows 10 recovery codes once with a copy button, and Continue waits for "I saved them"
  await expect(page.getByRole("heading", { name: "Save your recovery codes" })).toBeVisible();
  const items = page.getByRole("list", { name: "Recovery codes" }).getByRole("listitem");
  await expect(items).toHaveCount(10);
  const codes = (await items.allInnerTexts()).map((t) => t.trim());
  expect(new Set(codes).size).toBe(10);
  expect(codes.every((c) => c.length > 0)).toBe(true);
  await expect(page.getByRole("button", { name: "Copy codes" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Continue" })).toBeDisabled();
  await page.getByRole("checkbox", { name: "I saved them" }).check();
  await page.getByRole("button", { name: "Continue" }).click();

  // And it then asks for a passkey on another device or a hardware key and lets the owner skip it for now
  await expect(page.getByRole("heading", { name: "Set up a second way in" })).toBeVisible();
  await expect(page.getByText("Add a passkey on another device or a hardware key")).toBeVisible();
  await expect(page.getByRole("button", { name: "Add a passkey" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Skip for now" })).toBeVisible();

  // And the codes are not shown again anywhere in the app
  const seen: string[] = [];
  for (const url of [`${srv.origin}/onboarding`, `${srv.origin}/`, `${srv.origin}/settings/passkeys`]) {
    await page.goto(url);
    await page.waitForLoadState("networkidle");
    seen.push(await page.evaluate(() => document.body.innerText + JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage })));
  }
  expect(codes.filter((c) => seen.some((text) => text.includes(c)))).toEqual([]);
});

scenario("A recovery code works once", { tag: ["@api"] }, async ({ server }) => {
  // Given the owner used a recovery code (POST /api/auth/recovery {code}: 200, a limited device cookie)
  const srv = await server(apiServer());
  const owner = await bootstrapOwner(srv);
  const code = owner.codes[0]!;
  const device = new Client(srv.target);
  const first = await device.post("/api/auth/recovery", { code });
  expect(first.status).toBe(200);
  expect(device.jar.has(DEVICE_COOKIE)).toBe(true);

  // When the same code is entered again
  const again = await new Client(srv.target).post("/api/auth/recovery", { code });

  // Then the app says the code is not valid: 401 invalid_code, the same body as for a wrong code
  expect(again.status).toBe(401);
  expect(again.json().error.code).toBe("invalid_code");
  expect(again.json().error.message).toMatch(/not valid/i);
  const wrong = await new Client(srv.target).post("/api/auth/recovery", { code: "TESTONLY-wrong-code" });
  expect(again.text).toBe(wrong.text);
});

scenario("The owner cannot remove the last passkey", { tag: ["@browser"] }, async ({ server, page, context }) => {
  // Given the owner has one active passkey (made over the API, then put on the browser's device)
  const srv = await server({ host: "localhost", adminSocket: true });
  const owner = await bootstrapOwner(srv);
  const wa = await webauthn(context, page);
  await (await wa.add()).addCredential(owner.soft.exportForChromium());
  await uiSignIn(page, srv.origin);

  // When the owner tries to remove it
  await page.goto(`${srv.origin}/settings/passkeys`);
  await expect(page.getByRole("listitem")).toHaveCount(1);
  await page.getByRole("button", { name: "Remove passkey" }).click();

  // Then the app refuses and says another passkey must be added first
  await expect(page.getByRole("alert")).toContainText(/another passkey must be added first/i);
  const list = await page.request.get(`${srv.origin}/api/me/passkeys`);
  expect((await list.json()).passkeys).toHaveLength(1);
});

scenario("A device session slides for 30 days and ends at 90", { tag: ["@browser"] }, async ({ server, testApi, page, context }, info) => {
  info.setTimeout(90_000);
  const srv = await server({ host: "localhost", adminSocket: true });
  const clock = testApi(srv);
  const owner = await bootstrapOwner(srv);

  // A second device signs in once and is never used again, so only the 30-day idle rule can end it
  const idle = new Client(srv.target);
  await signIn(idle, owner.soft);

  // Given the owner signed in 29 days ago and used the app yesterday (daily use, in the browser)
  const wa = await webauthn(context, page);
  await (await wa.add()).addCredential(owner.soft.exportForChromium());
  await uiSignIn(page, srv.origin);
  const use = async () => (await page.request.get(`${srv.origin}/api/me`)).status();
  const days: number[] = [];
  for (let d = 1; d <= 29; d++) {
    await clock.advanceClock(DAY);
    days.push(await use());
  }
  expect(days.every((s) => s === 200)).toBe(true);

  // The idle device ends at 31 days; the daily one slides on past 30
  await clock.advanceClock(2 * DAY);
  expect((await idle.get("/api/me")).status).toBe(401);
  expect(await use()).toBe(200);
  for (let d = 32; d <= 89; d++) {
    await clock.advanceClock(DAY);
    days.push(await use());
  }
  expect(days.slice(29).every((s) => s === 200)).toBe(true);
  await page.goto(`${srv.origin}/`);
  await expect(page.getByRole("heading", { name: "Now", exact: true })).toBeVisible();

  // When the test clock reaches day 91 with daily use, Then the app asks the owner to sign in again
  await clock.advanceClock(2 * DAY);
  expect(await use()).toBe(401);
  // The page that is still open may notice the dead session first and redirect to /signin itself, which aborts this
  // goto (ERR_ABORTED). Either navigation ends on /signin, so tolerate the abort and assert where the page lands.
  await page.goto(`${srv.origin}/`).catch((err) => {
    if (!String(err).includes("ERR_ABORTED")) throw err;
  });
  await expect(page).toHaveURL(/\/signin(\?|$)/);
  await expect(page.getByRole("heading", { name: "Sign in", exact: true })).toBeVisible();
});
