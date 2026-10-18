import fs from "node:fs";
import { makeBootstrapLink } from "../lib/admin.ts";
import { Client } from "../lib/http.ts";
import { approveCard, createAgents, declineCard, nowCard, requestMachine, signInBrowser } from "../lib/machines.ts";
import { addSecondPasskey, backgroundLuminance, box, overflowX, shootBoth, smallTargets } from "../lib/mobile.ts";
import { bootstrapOwner, must, uiSignIn } from "../lib/owner.ts";
import { expect, scenario } from "../lib/scenario.ts";
import { SoftAuthenticator } from "../lib/soft-authenticator.ts";
import { webauthn } from "../lib/webauthn-browser.ts";

/*
 * S-U0 UI CONTRACT: the phone console (Refs #16). Read with specs/features/console-mobile.feature. Locators are role and text only.
 * Scenarios tagged @phone run in the "mobile" project (chromium 390x844, touch). The others run in "chromium" and "mobile".
 * In "mobile" the ceremony guard (lib/ceremony-guard.ts) fails ANY test where a tap starts two WebAuthn ceremonies, where a fetch()
 * sits between a tap and its ceremony, or where a ceremony starts without a tap. So each ceremony button must call
 * navigator.credentials.get/create at once, with options fetched BEFORE the tap. A button waits (disabled) until its options are
 * ready; after a failure the options are fetched again. A step-up or a ceremony older than 5 minutes is "stale" (server CeremonyTTL).
 *
 * FRAME (every page)
 *   banner: link "Convoz" (to /). Signed-in pages also have button "Account menu" (aria-haspopup="menu"). It opens role=menu with
 *     menuitems "Passkeys" (/settings/passkeys), "Recovery codes" (/settings/recovery) and "Sign out"; Escape closes it.
 *   navigation "Main" (bottom, signed-in pages): links "Now" (/), "Conversations" (/chats) and "Crew" (/crew), in that order (prototype v41;
 *     see tests/chat-ui.spec.ts). Account is not a tab: its page (/account; rows Passkeys, Recovery codes, Machines, Sign out) stays at /account.
 *   The frame, the menu and the nav have NO listitem elements (an existing scenario counts the listitems of /settings/passkeys).
 *   Buttons, menu items, nav links and text fields are at least 44 px tall. Primary buttons and text fields are full width (>= 342 px at
 *   390 px). Labels sit above their field. No page is wider than the screen at 390 px and at 320 px. Errors and notes appear in role=alert
 *   (errors) or role=status (notes and toasts), never in alert(). Dark is the default look (no colour preference); light under
 *   prefers-color-scheme: light. The page background luminance is < 0.25 in dark and > 0.75 in light.
 *
 * FIRST RUN  /bootstrap#<token>
 *   Link states are checked when the page opens. Unknown or missing token: heading "This link is not valid". Used: heading
 *   "This link was already used". Expired: heading "This link expired". Each shows the text "convoz admin bootstrap-link" (the command
 *   for a new link) and no form. When the visitor already has a session, the command is replaced by a link or button "Go to Convoz".
 *   Valid link: heading "Welcome to Convoz", a hint that the handle is lowercase (text /lowercase/i), textbox "Handle", textbox
 *   "Display name", button "Register passkey" (kept from S1a; disabled until both fields are valid and the options are ready).
 *   Step 2 of 3: text "Step 2 of 3", heading "Save your recovery codes", list "Recovery codes" (10 listitems), buttons "Copy codes" and
 *     "Download codes" (file convoz-recovery-codes.txt, one code per line), checkbox "I saved them", button "Continue" (disabled until the box
 *     is ticked). The codes live in memory only.
 *   Step 3 of 3 (/onboarding): text "Step 3 of 3", heading "Set up a second way in", text "Add a passkey on another device or a hardware key",
 *     and when the pointer is coarse or the screen is <= 600 px wide the text "On a phone, use your laptop or a security key for the
 *     second passkey.", button "Add a passkey" (same dialog as Passkeys), button "Skip for now" (to Now). Now then shows link
 *     "Add a second way in" (to /settings/passkeys) while the owner has one passkey.
 *
 * SIGN IN  /signin
 *   heading "Sign in", button "Sign in with a passkey", link "Lost your passkey? Use a recovery code" (to /recover). The login options are
 *   fetched when the page opens. Signed in already: the page goes to Now (/). After a good passkey sign-in the browser lands on Now (the ?next= path wins). After "Sign out" the page shows role=status "Signed out".
 *   Failures (role=alert): ceremony_invalid (stale) "The passkey check timed out. Tap again."; NotAllowedError "The passkey prompt was closed
 *   or timed out. Try again."; InvalidStateError "This device already has a Convoz passkey. Use another device or a security key."
 *   Any 401 from the console sends the browser to /signin?next=<path> (encoded); after sign in it goes to <path>. A page request without a
 *   session does the same.
 *
 * RECOVER  /recover
 *   heading "Use a recovery code", textbox "Recovery code" (spaces around and inside are ignored), button "Use code". After a good code the
 *   page offers only button "Add a passkey" (one tap, one create ceremony, options fetched when the code is accepted). Then the app shows
 *   Now with role=status "You signed in with a recovery code. Codes left: N. Some actions are paused for 24 hours."
 *
 * PASSKEYS  /settings/passkeys
 *   heading "Passkeys". One listitem per passkey with: its label; "Added with the setup link" | "Added in settings" | "Added with a recovery
 *   code"; "Last used <date>" or "Never used"; "Added just now" when added in the last minute; badge "This device" (only the passkey of
 *   this session); button "Remove passkey". Removing the last passkey stays refused with role=alert "Another passkey must be added first."
 *   (the button stays enabled so the owner can read the reason).
 *   Button "Add a passkey" opens dialog "Add a passkey" with buttons "Confirm it's you" (one get ceremony, step-up passkey.add) and then
 *   "Create the new passkey" (one create ceremony). Success closes the dialog and the row appears. Errors show in role=alert.
 *   Button "Remove passkey" opens a dialog that names the passkey (its label) with button "Remove" (one get ceremony, step-up
 *   passkey.remove, options fetched when the dialog opens) and "Cancel".
 *
 * RECOVERY CODES  /settings/recovery
 *   heading "Recovery codes", text "N of 10 codes left", the warning "Making new codes stops the old ones from working.", button
 *   "Make new codes" (one get ceremony, step-up recovery.regenerate, then POST /api/me/recovery-codes). Success: list "Recovery codes"
 *   (10 listitems) shown once with "Copy codes" and "Download codes"; the count is refreshed. A lost or failed answer: role=alert with
 *   "try again" and the button stays enabled (its options are fetched again). passkey_too_new: role=alert "This passkey was added less than
 *   24 hours ago. Actions like this need an older passkey, so try again later or sign in with an older one."
 *
 * NOW  /   heading "Now" (exact). A machine request card is article "<name> wants to connect" with the name, "Source: <node> (<ip>)" or
 *   "Source: unknown (<ip>)", and the code. "Approve" is one tap on the card, fully in view at 390x844: no sheet, no passkey prompt, no code
 *   to type (owner: "Approvals just go into the feed"). After approval role=status shows "Approved <name>". "Decline" is one tap with no
 *   confirm; role=status shows "Declined <name>".
 */

const local = { host: "localhost", adminSocket: true } as const;
const nowHeading = (page: import("@playwright/test").Page) => page.getByRole("heading", { name: "Now", exact: true });
// Prototype v41: Now is the first tab, so signing in lands on Now (/).

scenario("Signing in takes one tap and one passkey prompt", { tag: ["@browser"] }, async ({ server, page, context, guard }) => {
  // Given the owner has a passkey on this device
  const srv = await server(local);
  const owner = await bootstrapOwner(srv);
  const wa = await webauthn(context, page);
  await (await wa.add()).addCredential(owner.soft.exportForChromium());

  // When the owner opens the sign-in page and taps "Sign in with a passkey"
  await page.goto(`${srv.origin}/signin`);
  await page.getByRole("button", { name: "Sign in with a passkey" }).click();

  // Then one passkey prompt opens at once, with no network call waited on between the tap and the prompt
  await expect(nowHeading(page)).toBeVisible();
  expect(guard.ceremonies()).toEqual([{ kind: "get", path: "/signin" }]);
  expect(guard.violations()).toEqual([]);
});

scenario("Adding a passkey takes a check and then a create, one prompt each", { tag: ["@browser"] }, async ({ server, page, context, guard }) => {
  // Given the owner is signed in and opens Passkeys
  const srv = await server(local);
  const owner = await bootstrapOwner(srv);
  const wa = await webauthn(context, page);
  const phone = await wa.add();
  await phone.addCredential(owner.soft.exportForChromium());
  await uiSignIn(page, srv.origin);
  await page.goto(`${srv.origin}/settings/passkeys`);
  const before = guard.ceremonies().length;

  // When the owner taps "Add a passkey", then "Confirm it's you", then "Create the new passkey" on a security key
  await page.getByRole("button", { name: "Add a passkey" }).click();
  const dialog = page.getByRole("dialog", { name: "Add a passkey" });
  await dialog.getByRole("button", { name: "Confirm it's you" }).click();
  await expect(dialog.getByRole("button", { name: "Create the new passkey" })).toBeVisible();
  await phone.remove();
  await wa.add();
  await dialog.getByRole("button", { name: "Create the new passkey" }).click();

  // Then each of the last two taps opens exactly one passkey prompt, at once
  await expect(page.getByRole("listitem")).toHaveCount(2);
  expect(guard.ceremonies().slice(before).map((c) => c.kind)).toEqual(["get", "create"]);
  expect(guard.violations()).toEqual([]);

  // And the list shows two passkeys and the new one says "Added just now"
  await expect(page.getByRole("listitem").filter({ hasText: "Added just now" })).toHaveCount(1);
});

scenario("A stale passkey prompt is renewed and the next tap works", { tag: ["@browser"] }, async ({ server, testApi, page, context, guard }) => {
  const srv = await server(local);
  const owner = await bootstrapOwner(srv);
  const wa = await webauthn(context, page);
  await (await wa.add()).addCredential(owner.soft.exportForChromium());

  // Given the owner opened the sign-in page more than 5 minutes ago
  await page.goto(`${srv.origin}/signin`);
  const signIn = page.getByRole("button", { name: "Sign in with a passkey" });
  await expect(signIn).toBeEnabled();
  await testApi(srv).advanceClock(6 * 60_000);

  // When the owner taps "Sign in with a passkey"
  await signIn.click();

  // Then the app says the check timed out and asks for another tap
  await expect(page.getByRole("alert")).toContainText("The passkey check timed out. Tap again.");

  // And the next tap signs the owner in with one passkey prompt
  await expect(signIn).toBeEnabled();
  await signIn.click();
  await expect(nowHeading(page)).toBeVisible();
  expect(guard.violations()).toEqual([]);
});

scenario("A device that already has a Convoz passkey gets a clear message", { tag: ["@browser"] }, async ({ server, page, context }) => {
  // Given the owner is signed in and opens Passkeys
  const srv = await server(local);
  const owner = await bootstrapOwner(srv);
  const wa = await webauthn(context, page);
  await (await wa.add()).addCredential(owner.soft.exportForChromium());
  await uiSignIn(page, srv.origin);
  await page.goto(`${srv.origin}/settings/passkeys`);

  // When the owner taps "Add a passkey", then "Confirm it's you", then "Create the new passkey" on the same device
  await page.getByRole("button", { name: "Add a passkey" }).click();
  const dialog = page.getByRole("dialog", { name: "Add a passkey" });
  await dialog.getByRole("button", { name: "Confirm it's you" }).click();
  await dialog.getByRole("button", { name: "Create the new passkey" }).click();

  // Then the app says this device already has a Convoz passkey and to use another device or a security key
  await expect(page.getByRole("alert")).toContainText("This device already has a Convoz passkey. Use another device or a security key.");
});

scenario("A closed passkey prompt shows a plain message and can be retried", { tag: ["@browser"] }, async ({ server, page, context, guard }) => {
  const srv = await server(local);
  const owner = await bootstrapOwner(srv);
  const wa = await webauthn(context, page);
  await (await wa.add()).addCredential(owner.soft.exportForChromium());

  // Given the owner opened the sign-in page
  await page.goto(`${srv.origin}/signin`);
  const signIn = page.getByRole("button", { name: "Sign in with a passkey" });
  await expect(signIn).toBeEnabled();

  // When the owner closes the passkey prompt
  await guard.rejectNext(page, "NotAllowedError");
  await signIn.click();

  // Then the app says the prompt was closed or timed out and to try again
  await expect(page.getByRole("alert")).toContainText("The passkey prompt was closed or timed out. Try again.");

  // And the next tap signs the owner in
  await expect(signIn).toBeEnabled();
  await signIn.click();
  await expect(nowHeading(page)).toBeVisible();
  expect(guard.violations()).toEqual([]);
});

scenario("The owner approves and declines machines from a phone", { tag: ["@browser", "@phone"] }, async ({ server, page, context, guard }) => {
  // Given machines "box-2" and "box-3" wait for approval and the owner is signed in on a phone
  const srv = await server(local);
  const owner = await bootstrapOwner(srv);
  await createAgents(owner, "devtool");
  const box2 = await requestMachine(srv, owner, "box-2");
  await requestMachine(srv, owner, "box-3");
  await signInBrowser(srv, owner, page, context);

  // Then the card showed the machine name, the source address and the code
  const card = nowCard(page, "box-2");
  await expect(card).toContainText("box-2");
  await expect(card).toContainText(/Source:\s*unknown \(\S+\)/);
  await expect(card).toContainText(box2.userCode);

  // And the Approve button on the card is in view and at least 44 px tall
  const approve = card.getByRole("button", { name: "Approve", exact: true });
  const b = await box(approve);
  expect(b.height).toBeGreaterThanOrEqual(44);
  expect(b.y + b.height).toBeLessThanOrEqual(844);

  // When the owner taps Approve on the card of "box-2"
  const before = guard.ceremonies().length;
  await approveCard(page, "box-2");

  // Then the app says "Approved box-2" at once, with no passkey prompt, no sheet and no code to type
  await expect(page.getByRole("status").filter({ hasText: "Approved box-2" })).toBeVisible();
  expect(guard.ceremonies().slice(before)).toEqual([]);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(guard.violations()).toEqual([]);

  // And one tap on Decline removes the card of "box-3"
  await declineCard(page, "box-3");
  await expect(nowCard(page, "box-3")).toBeHidden();
});

scenario("First run on a phone creates the owner, saves the codes, then offers a second way in", { tag: ["@browser", "@phone"] }, async ({ server, page, context, guard }) => {
  // Given the owner opens a setup link on a phone
  const srv = await server(local);
  const link = await makeBootstrapLink(srv.adminSocket!);
  const wa = await webauthn(context, page);
  await wa.add();
  await page.goto(`${srv.origin}/bootstrap#${link.token}`);

  // Then the first page says "Welcome to Convoz" and asks for a handle and a display name
  await expect(page.getByRole("heading", { name: "Welcome to Convoz" })).toBeVisible();
  await expect(page.getByText(/lowercase/i)).toBeVisible();

  // When the owner creates the first passkey
  await page.getByRole("textbox", { name: "Handle" }).fill("drew");
  await page.getByRole("textbox", { name: "Display name" }).fill("Drew");
  await page.getByRole("button", { name: "Register passkey" }).click();

  // And step 2 of 3 shows the 10 recovery codes and Continue waits for "I saved them"
  await expect(page.getByRole("heading", { name: "Save your recovery codes" })).toBeVisible();
  await expect(page.getByText("Step 2 of 3")).toBeVisible();
  await expect(page.getByRole("list", { name: "Recovery codes" }).getByRole("listitem")).toHaveCount(10);
  await expect(page.getByRole("button", { name: "Continue" })).toBeDisabled();
  await page.getByRole("checkbox", { name: "I saved them" }).check();
  await page.getByRole("button", { name: "Continue" }).click();

  // And step 3 of 3 tells the owner to use a laptop or a security key and offers "Skip for now"
  await expect(page.getByRole("heading", { name: "Set up a second way in" })).toBeVisible();
  await expect(page.getByText("Step 3 of 3")).toBeVisible();
  await expect(page.getByText(/laptop or a security key/i)).toBeVisible();
  await page.getByRole("button", { name: "Skip for now" }).click();

  // And the app shows Now with a reminder to add a second way in
  await expect(nowHeading(page)).toBeVisible();
  await expect(page.getByRole("link", { name: "Add a second way in" })).toBeVisible();
  expect(guard.violations()).toEqual([]);
});

scenario("Recovery codes are shown once with Copy and Download", { tag: ["@browser"] }, async ({ server, page, context }) => {
  // Given the owner registered the first passkey
  const srv = await server(local);
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: srv.origin });
  const link = await makeBootstrapLink(srv.adminSocket!);
  const wa = await webauthn(context, page);
  await wa.add();
  await page.goto(`${srv.origin}/bootstrap#${link.token}`);
  await page.getByRole("textbox", { name: "Handle" }).fill("drew");
  await page.getByRole("textbox", { name: "Display name" }).fill("Drew");
  await page.getByRole("button", { name: "Register passkey" }).click();

  // When the app shows the recovery codes
  const items = page.getByRole("list", { name: "Recovery codes" }).getByRole("listitem");
  await expect(items).toHaveCount(10);
  const codes = (await items.allInnerTexts()).map((t) => t.trim());

  // Then the owner can copy all 10 codes
  await page.getByRole("button", { name: "Copy codes" }).click();
  await expect(page.getByRole("status")).toContainText("Copied");
  expect((await page.evaluate(() => navigator.clipboard.readText())).split("\n").map((c) => c.trim()).filter(Boolean)).toEqual(codes);

  // And the owner can download all 10 codes as a text file
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Download codes" }).click()]);
  expect(download.suggestedFilename()).toBe("convoz-recovery-codes.txt");
  const file = fs.readFileSync(await download.path(), "utf8");
  expect(codes.filter((c) => !file.includes(c))).toEqual([]);
});

scenario("A used, expired or missing setup link says what happened and how to get a new one", { tag: ["@browser"] }, async ({ server, testApi, page, context }) => {
  const srv = await server(local);
  const expired = await makeBootstrapLink(srv.adminSocket!);
  await testApi(srv).advanceClock(601_000);
  const used = (await bootstrapOwner(srv)).link;
  const cases = [
    { state: "used", url: `${srv.origin}/bootstrap#${used.token}`, title: "This link was already used" },
    { state: "expired", url: `${srv.origin}/bootstrap#${expired.token}`, title: "This link expired" },
    { state: "missing", url: `${srv.origin}/bootstrap`, title: "This link is not valid" },
  ];
  for (const c of cases) {
    // Given a setup link that is <state>; When the owner opens the link
    await page.goto(c.url);

    // Then the page says "<title>", gives the command for a new link and has no form
    await expect(page.getByRole("heading", { name: c.title }), c.state).toBeVisible();
    await expect(page.getByText("convoz admin bootstrap-link"), c.state).toBeVisible();
    await expect(page.getByRole("textbox"), c.state).toHaveCount(0);
  }

  // A link used between the check and the tap shows the plain "already used" line, not a raw server message
  const raced = await makeBootstrapLink(srv.adminSocket!);
  await (await webauthn(context, page)).add();
  await page.goto(`${srv.origin}/bootstrap#${raced.token}`);
  await expect(page.getByRole("heading", { name: "Welcome to Convoz" })).toBeVisible();
  await bootstrapOwner(srv, { link: raced, handle: "other", displayName: "Other" });
  await page.getByRole("textbox", { name: "Handle" }).fill("drew");
  await page.getByRole("textbox", { name: "Display name" }).fill("Drew");
  await expect(page.getByText("This setup link was already used.")).toBeVisible();
});

scenario("A used setup link opened while signed in offers Go to Convoz", { tag: ["@browser"] }, async ({ server, page, context }) => {
  // Given the owner is signed in
  const srv = await server(local);
  const owner = await bootstrapOwner(srv);
  await signInBrowser(srv, owner, page, context);

  // When the owner opens a setup link that was already used
  await page.goto(`${srv.origin}/bootstrap#${owner.link.token}`);

  // Then the page offers "Go to Convoz" instead of the command
  await expect(page.getByRole("heading", { name: "This link was already used" })).toBeVisible();
  await expect(page.getByText("convoz admin bootstrap-link")).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Go to Convoz" }).or(page.getByRole("button", { name: "Go to Convoz" }))).toBeVisible();
});

scenario("Opening sign-in while signed in goes to Now", { tag: ["@browser"] }, async ({ server, page, context }) => {
  // Given the owner is signed in
  const srv = await server(local);
  const owner = await bootstrapOwner(srv);
  await signInBrowser(srv, owner, page, context);

  // When the owner opens the sign-in page
  await page.goto(`${srv.origin}/signin`);

  // Then the app shows Now
  await expect(nowHeading(page)).toBeVisible();
  await expect(page).toHaveURL(`${srv.origin}/`);
});

scenario("An expired session sends the owner to sign in and back", { tag: ["@browser"] }, async ({ server, page, context, guard }) => {
  // Given the owner is signed in on Recovery codes and the session ends
  const srv = await server(local);
  const owner = await bootstrapOwner(srv);
  await signInBrowser(srv, owner, page, context);
  await page.goto(`${srv.origin}/settings/recovery`);
  const make = page.getByRole("button", { name: "Make new codes" });
  await expect(make).toBeEnabled();
  await context.clearCookies();

  // When the owner taps "Make new codes"
  await make.click();

  // Then the app shows Sign in and keeps the page the owner was on
  await expect(page).toHaveURL(`${srv.origin}/signin?next=%2Fsettings%2Frecovery`);
  await expect(page.getByRole("heading", { name: "Sign in", exact: true })).toBeVisible();

  // And after signing in the app shows Recovery codes again
  await page.getByRole("button", { name: "Sign in with a passkey" }).click();
  await expect(page).toHaveURL(`${srv.origin}/settings/recovery`);
  await expect(page.getByRole("heading", { name: "Recovery codes" })).toBeVisible();
  expect(guard.violations()).toEqual([]);
});

scenario("A lost phone is recovered with a recovery code and a new passkey", { tag: ["@browser"] }, async ({ server, page, context, guard }) => {
  // Given the owner lost every passkey and types a recovery code with spaces
  const srv = await server(local);
  const owner = await bootstrapOwner(srv);
  const code = owner.codes[0]!;
  const wa = await webauthn(context, page);
  await wa.add();

  // When the owner taps "Lost your passkey? Use a recovery code" and then "Add a passkey"
  await page.goto(`${srv.origin}/signin`);
  await page.getByRole("link", { name: "Lost your passkey? Use a recovery code" }).click();
  await expect(page.getByRole("heading", { name: "Use a recovery code" })).toBeVisible();
  await page.getByRole("textbox", { name: "Recovery code" }).fill(` ${code.slice(0, 4)} ${code.slice(4)} `);
  await page.getByRole("button", { name: "Use code" }).click();
  const add = page.getByRole("button", { name: "Add a passkey" });
  await expect(add).toBeVisible();

  // Then the page offers nothing else but adding a passkey
  await expect(page.getByRole("main").getByRole("button")).toHaveCount(1);
  const before = guard.ceremonies().length;
  await add.click();

  // And one passkey prompt opens at once
  await expect(nowHeading(page)).toBeVisible();
  expect(guard.ceremonies().slice(before).map((c) => c.kind)).toEqual(["create"]);
  expect(guard.violations()).toEqual([]);

  // And the app shows Now with the note that codes are left and that some actions are paused for 24 hours
  await expect(page.getByRole("status").filter({ hasText: "You signed in with a recovery code. Codes left: 9. Some actions are paused for 24 hours." })).toBeVisible();
});

scenario("The recovery codes page says how many codes are left", { tag: ["@browser"] }, async ({ server, page, context }) => {
  // Given the owner used one recovery code
  const srv = await server(local);
  const owner = await bootstrapOwner(srv);
  must(await new Client(srv.target).post("/api/auth/recovery", { code: owner.codes[0]! }), "use recovery code");
  await signInBrowser(srv, owner, page, context);

  // When the owner opens Recovery codes
  await page.goto(`${srv.origin}/settings/recovery`);

  // Then the page says "9 of 10 codes left"
  await expect(page.getByText("9 of 10 codes left")).toBeVisible();
});

scenario("New recovery codes need a passkey check and void the old set", { tag: ["@browser"] }, async ({ server, page, context, guard }) => {
  // Given the owner is signed in and opens Recovery codes from the account menu
  const srv = await server(local);
  const owner = await bootstrapOwner(srv);
  await signInBrowser(srv, owner, page, context);
  await page.getByRole("button", { name: "Account menu" }).click();
  await page.getByRole("menuitem", { name: "Recovery codes" }).click();
  await expect(page.getByText("10 of 10 codes left")).toBeVisible();
  const before = guard.ceremonies().length;

  // When the owner taps "Make new codes"
  await page.getByRole("button", { name: "Make new codes" }).click();

  // Then one passkey prompt opens at once
  const items = page.getByRole("list", { name: "Recovery codes" }).getByRole("listitem");
  await expect(items).toHaveCount(10);
  expect(guard.ceremonies().slice(before).map((c) => c.kind)).toEqual(["get"]);
  expect(guard.violations()).toEqual([]);

  // And 10 new codes are shown once, with Copy and Download
  const fresh = (await items.allInnerTexts()).map((t) => t.trim());
  await expect(page.getByRole("button", { name: "Copy codes" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Download codes" })).toBeVisible();

  // And the codes are not shown again after the page reloads
  await page.reload();
  await expect(page.getByText("10 of 10 codes left")).toBeVisible();
  await expect(page.getByRole("list", { name: "Recovery codes" })).toHaveCount(0);

  // And the old codes no longer work, and a new one does
  const old = await new Client(srv.target).post("/api/auth/recovery", { code: owner.codes[0]! });
  expect(old.status).toBe(401);
  const good = await new Client(srv.target).post("/api/auth/recovery", { code: fresh[0]! });
  expect(good.status).toBe(200);
});

scenario("New recovery codes are refused while the newest passkey is under the 24-hour hold", { tag: ["@browser"] }, async ({ server, testApi, page, context }) => {
  const srv = await server(local);
  const owner = await bootstrapOwner(srv);

  // Given the owner signed in with a passkey added by a recovery code 2 hours ago
  const limited = new Client(srv.target);
  must(await limited.post("/api/auth/recovery", { code: owner.codes[0]! }), "use recovery code");
  const young = new SoftAuthenticator(srv.host, srv.origin);
  const opt = must(await limited.post("/api/auth/passkey/register/options", {}), "register options").json();
  must(await limited.post("/api/auth/passkey/register/verify", { ceremony_id: opt.ceremony_id, credential: young.create(opt.options.publicKey) }), "register verify");
  await testApi(srv).advanceClock(2 * 3_600_000);
  const wa = await webauthn(context, page);
  await (await wa.add()).addCredential(young.exportForChromium());
  await uiSignIn(page, srv.origin);
  await page.goto(`${srv.origin}/settings/recovery`);

  // When the owner taps "Make new codes"
  await page.getByRole("button", { name: "Make new codes" }).click();

  // Then the app explains that the passkey is less than 24 hours old and that an older passkey is needed
  const alert = page.getByRole("alert");
  await expect(alert).toContainText("less than 24 hours");
  await expect(alert).toContainText("older passkey");

  // And the button "Make new codes" stays
  await expect(page.getByRole("button", { name: "Make new codes" })).toBeVisible();
});

scenario("A lost answer on new recovery codes can be retried", { tag: ["@browser"] }, async ({ server, page, context }) => {
  const srv = await server(local);
  const owner = await bootstrapOwner(srv);
  await signInBrowser(srv, owner, page, context);

  // Given the answer to "Make new codes" is lost on the way
  let posts = 0;
  await page.route("**/api/me/recovery-codes", async (route) => {
    if (route.request().method() !== "POST" || posts++ > 0) return route.fallback();
    await route.fetch();
    await route.abort("failed");
  });
  await page.goto(`${srv.origin}/settings/recovery`);
  const make = page.getByRole("button", { name: "Make new codes" });

  // When the owner taps "Make new codes" again
  await make.click();

  // Then the first try says to try again and keeps the button
  await expect(page.getByRole("alert")).toContainText(/try again/i);
  await expect(make).toBeEnabled();
  await make.click();

  // And the second try shows 10 codes that work
  const items = page.getByRole("list", { name: "Recovery codes" }).getByRole("listitem");
  await expect(items).toHaveCount(10);
  const first = (await items.first().innerText()).trim();
  expect((await new Client(srv.target).post("/api/auth/recovery", { code: first })).status).toBe(200);
});

scenario("The passkeys list shows last used, how each was added and this device", { tag: ["@browser"] }, async ({ server, page, context }) => {
  // Given the owner has two passkeys and signed in with the first on this device
  const srv = await server(local);
  const owner = await bootstrapOwner(srv);
  await addSecondPasskey(srv, owner);
  await signInBrowser(srv, owner, page, context);

  // When the owner opens Passkeys
  await page.goto(`${srv.origin}/settings/passkeys`);
  const rows = page.getByRole("listitem");
  await expect(rows).toHaveCount(2);

  // Then the first passkey is marked "This device", shows its last use and says it was added with the setup link
  const thisDevice = rows.filter({ hasText: "This device" });
  await expect(thisDevice).toContainText("Added with the setup link");
  await expect(thisDevice).toContainText("Last used");

  // And the second passkey shows "Never used" and says it was added in settings
  const other = rows.filter({ hasNotText: "This device" });
  await expect(other).toContainText("Never used");
  await expect(other).toContainText("Added in settings");

  // And only one passkey is marked "This device"
  await expect(thisDevice).toHaveCount(1);
});

scenario("Removing a passkey asks for confirmation and one passkey prompt", { tag: ["@browser"] }, async ({ server, page, context, guard }) => {
  // Given the owner has two passkeys and is signed in with the first
  const srv = await server(local);
  const owner = await bootstrapOwner(srv);
  await addSecondPasskey(srv, owner);
  const listed = must(await owner.client.get("/api/me/passkeys"), "list passkeys").json().passkeys as { label: string; registered_via: string }[];
  const secondLabel = listed.find((p) => p.registered_via === "session")!.label;
  await signInBrowser(srv, owner, page, context);
  await page.goto(`${srv.origin}/settings/passkeys`);
  const before = guard.ceremonies().length;

  // When the owner taps "Remove passkey" on the second, reads the confirm sheet naming it and confirms
  await page.getByRole("listitem").filter({ hasText: "Never used" }).getByRole("button", { name: "Remove passkey" }).click();
  const sheet = page.getByRole("dialog");
  await expect(sheet).toContainText(secondLabel);
  await sheet.getByRole("button", { name: "Remove", exact: true }).click();

  // Then one passkey prompt opens at once
  await expect(page.getByRole("listitem")).toHaveCount(1);
  expect(guard.ceremonies().slice(before).map((c) => c.kind)).toEqual(["get"]);
  expect(guard.violations()).toEqual([]);

  // And the second passkey is gone from the list
  await expect(page.getByRole("listitem").filter({ hasText: "Never used" })).toHaveCount(0);
});

scenario("The account menu lists Passkeys, Recovery codes and Sign out", { tag: ["@browser", "@phone"] }, async ({ server, page, context }) => {
  // Given the owner is signed in on a phone
  const srv = await server(local);
  const owner = await bootstrapOwner(srv);
  await signInBrowser(srv, owner, page, context);

  // When the owner opens the account menu
  await page.getByRole("button", { name: "Account menu" }).click();

  // Then the menu lists "Passkeys", "Recovery codes" and "Sign out"
  const menu = page.getByRole("menu");
  await expect(menu.getByRole("menuitem")).toHaveText(["Passkeys", "Recovery codes", "Sign out"]);

  // And the bottom nav shows "Now", "Conversations" and "Crew"
  const nav = page.getByRole("navigation", { name: "Main" });
  await expect(nav.getByRole("link")).toHaveText(["Now", "Conversations", "Crew"]);
});

scenario("Sign out from the account menu ends the session", { tag: ["@browser", "@phone"] }, async ({ server, page, context }) => {
  // Given the owner is signed in on a phone
  const srv = await server(local);
  const owner = await bootstrapOwner(srv);
  await signInBrowser(srv, owner, page, context);

  // When the owner picks "Sign out" in the account menu
  await page.getByRole("button", { name: "Account menu" }).click();
  await page.getByRole("menuitem", { name: "Sign out" }).click();

  // Then the app shows Sign in with the note "Signed out"
  await expect(page.getByRole("heading", { name: "Sign in", exact: true })).toBeVisible();
  await expect(page.getByRole("status")).toContainText("Signed out");

  // And the old session no longer works
  expect((await page.request.get(`${srv.origin}/api/me`)).status()).toBe(401);
});

scenario("Forms on a phone have labels above full-width fields and a full-width main button", { tag: ["@browser", "@phone"] }, async ({ server, page, context }, info) => {
  // Given the owner is on a phone
  const srv = await server(local);
  const owner = await bootstrapOwner(srv);
  const setup = await makeBootstrapLink(srv.adminSocket!);
  const forms = [
    { name: "setup", url: `${srv.origin}/bootstrap#${setup.token}`, fields: ["Handle", "Display name"], main: "Register passkey" },
    { name: "recover", url: `${srv.origin}/recover`, fields: ["Recovery code"], main: "Use code" },
    { name: "signin", url: `${srv.origin}/signin`, fields: [] as string[], main: "Sign in with a passkey" },
  ];

  // When the owner opens the setup page, the recovery code page and the sign-in page
  for (const f of forms) {
    await page.goto(f.url);
    const main = page.getByRole("button", { name: f.main });
    await expect(main, f.name).toBeVisible();

    // Then every label sits above its field, and every field is full width and at least 44 px tall
    for (const label of f.fields) {
      const field = await box(page.getByRole("textbox", { name: label }));
      const text = await box(page.locator("label", { hasText: label }));
      expect(text.y + text.height, `${f.name} label ${label} is above its field`).toBeLessThanOrEqual(field.y + 1);
      expect(field.width, `${f.name} field ${label} is full width`).toBeGreaterThanOrEqual(342);
      expect(field.height, `${f.name} field ${label}`).toBeGreaterThanOrEqual(44);
    }

    // And the main button is full width and at least 44 px tall
    const m = await box(main);
    expect(m.width, `${f.name} main button is full width`).toBeGreaterThanOrEqual(342);
    expect(m.height, `${f.name} main button`).toBeGreaterThanOrEqual(44);
    expect(await smallTargets(page), `${f.name} targets`).toEqual([]);
    await shootBoth(page, info, f.name);
  }

  // And every button and menu item on a phone is at least 44 px tall (signed-in pages and the open menu)
  await signInBrowser(srv, owner, page, context);
  for (const path of ["/", "/settings/passkeys", "/settings/recovery", "/crew/machines", "/account"]) {
    await page.goto(`${srv.origin}${path}`);
    await page.getByRole("button", { name: "Account menu" }).click();
    expect(await smallTargets(page), path).toEqual([]);
    await shootBoth(page, info, path === "/" ? "now" : path.slice(1).replace("/", "-"));
  }
});

scenario("No page scrolls sideways on a phone", { tag: ["@browser", "@phone"] }, async ({ server, page, context }) => {
  // Given the owner is on a phone
  const srv = await server(local);
  const owner = await bootstrapOwner(srv);
  const setup = await makeBootstrapLink(srv.adminSocket!);
  const signedOut = [
    ["Sign in", "/signin"],
    ["Recovery code", "/recover"],
    ["Setup", `/bootstrap#${setup.token}`],
    ["Used setup link", `/bootstrap#${owner.link.token}`],
  ];
  const signedIn = [
    ["Now", "/"],
    ["Machines", "/crew/machines"],
    ["Passkeys", "/settings/passkeys"],
    ["Recovery codes", "/settings/recovery"],
    ["Second way in", "/onboarding"],
  ];
  const wide: string[] = [];
  const visit = async (rows: string[][]) => {
    for (const [name, path] of rows) {
      for (const width of [390, 320]) {
        // When the owner opens "<page>"
        await page.setViewportSize({ width, height: 844 });
        await page.goto(`${srv.origin}${path}`);
        await page.waitForLoadState("networkidle");
        if ((await overflowX(page)) > 0) wide.push(`${name} at ${width}px`);
      }
    }
  };
  await visit(signedOut);
  await page.setViewportSize({ width: 390, height: 844 });
  await signInBrowser(srv, owner, page, context);
  await visit(signedIn);

  // Then the page is no wider than a 390 px screen and no wider than a 320 px screen
  expect(wide).toEqual([]);
});

scenario("The console follows the phone's dark or light setting", { tag: ["@browser", "@phone"] }, async ({ server, page, context }, info) => {
  // Given the owner is on a phone
  const srv = await server(local);
  const owner = await bootstrapOwner(srv);
  const seen: Record<string, Record<string, number>> = {};
  const look = async (name: string) => {
    // When the owner opens each page with the phone set to dark and to light
    seen[name] = {};
    for (const scheme of ["dark", "light"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      seen[name]![scheme] = await backgroundLuminance(page);
    }
    await shootBoth(page, info, name);
  };
  await page.goto(`${srv.origin}/signin`);
  await look("signin");
  await signInBrowser(srv, owner, page, context);
  for (const [name, path] of [["now", "/"], ["passkeys", "/settings/passkeys"], ["recovery", "/settings/recovery"]] as const) {
    await page.goto(`${srv.origin}${path}`);
    await look(name);
  }

  // Then the pages are dark when the phone is dark
  const notDark = Object.entries(seen).filter(([, s]) => s["dark"]! >= 0.25).map(([n]) => n);
  expect(notDark).toEqual([]);

  // And the pages are light when the phone is light, and a screenshot of each page in dark and in light is attached
  const notLight = Object.entries(seen).filter(([, s]) => s["light"]! <= 0.75).map(([n]) => n);
  expect(notLight).toEqual([]);
  expect(info.attachments.filter((a) => a.contentType === "image/png")).toHaveLength(8);
});
