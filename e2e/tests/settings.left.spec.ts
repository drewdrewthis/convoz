import { convoz, inboxItems, ownerSays } from "../lib/chat.ts";
import { inboxWorld } from "../lib/left.ts";
import { signInBrowser } from "../lib/machines.ts";
import { addSecondPasskey, signInWith } from "../lib/mobile.ts";
import { apiServer, bootstrapOwner, must } from "../lib/owner.ts";
import { expect, scenario } from "../lib/scenario.ts";

// Bindings of settings.feature and contracts/settings.feature that no earlier work package bound. "Media auto-load decides when images
// load" belongs to the offline work package.

const patch = (owner: { client: { request: Function } }, body: unknown) => owner.client.request("PATCH", "/api/settings", { csrf: true, json: body });

scenario("The owner sets the workspace inbox and brief defaults", { tag: ["@api"] }, async ({ server, testApi }) => {
  // Given "devtool" has a mention and a handoff note of 4000 bytes
  const { w, conv, s1, s2 } = await inboxWorld(server);
  await ownerSays(w.owner, conv, "@devtool defaults?");
  const note = await convoz(w.box, s1.sid, ["handoff", "-"], "x".repeat(4000));
  expect(note.code, note.stderr).toBe(0);

  // When the owner sets "inbox.visibility_default" to "10m" and "brief.max_bytes" to 12000
  must(await patch(w.owner, { scope: "workspace", key: "inbox.visibility_default", value: "10m" }), "set the visibility", 200);
  must(await patch(w.owner, { scope: "workspace", key: "brief.max_bytes", value: 12000 }), "set the brief size", 200);

  // Then a new agent claim without a visibility holds its items for 10 minutes
  const claimed = await inboxItems(w.box, s1.sid, ["--claim", "1", "--wait", "0"]);
  expect(claimed.map((i) => i.conversation.id)).toEqual([conv]);
  await testApi(w.srv).advanceClock(9 * 60_000);
  expect(await inboxItems(w.box, s2.sid, ["--claim", "1", "--wait", "0"]), "taken before 10 minutes").toEqual([]);
  await testApi(w.srv).advanceClock(61_000);
  const taken = await inboxItems(w.box, s2.sid, ["--claim", "1", "--wait", "0"]);
  expect(taken.map((i) => i.id)).toEqual([claimed[0]!.id]);

  // And "convoz brief" without --max-bytes returns at most 12000 bytes
  const full = await convoz(w.box, s2.sid, ["brief"]);
  expect(full.code, full.stderr).toBe(0);
  expect(Buffer.byteLength(full.stdout)).toBeLessThanOrEqual(12000);
  // (the setting is what limits it: at its smallest value the same brief is cut to that size)
  expect(Buffer.byteLength(full.stdout)).toBeGreaterThan(4096);
  must(await patch(w.owner, { scope: "workspace", key: "brief.max_bytes", value: 4096 }), "set the brief size", 200);
  const small = await convoz(w.box, s2.sid, ["brief"]);
  expect(Buffer.byteLength(small.stdout)).toBeLessThanOrEqual(4096);
});

// ---- contracts/settings.feature --------------------------------------------------------------------------

scenario("Bad settings are refused", { tag: ["@api"] }, async ({ server }) => {
  const srv = await server(apiServer());
  const owner = await bootstrapOwner(srv);
  const rows: [string, unknown][] = [
    ['an unknown key "notify.everything" to true', { scope: "user", key: "notify.everything", value: true }],
    ['"notify.previews" to "loud"', { scope: "user", key: "notify.previews", value: "loud" }],
    ['"notify.quiet_hours" to {"start": "25:00", "end": "07:00"}', { scope: "user", key: "notify.quiet_hours", value: { start: "25:00", end: "07:00" } }],
    ['the device-only key "theme" on the server', { scope: "user", key: "theme", value: "dark" }],
  ];
  for (const [change, body] of rows) {
    // When the owner sets <change>
    const res = await patch(owner, body);

    // Then the server answers 400
    expect([change, res.status]).toEqual([change, 400]);
  }
  // (and the refusals changed nothing: the previews setting still reads its default)
  const read = must(await owner.client.get("/api/settings"), "read settings").json().settings as { key: string; value: unknown }[];
  expect(read.find((s) => s.key === "notify.previews")?.value).toBe("full");
});

// ---- settings.feature: signing out ------------------------------------------------------------------------

scenario("Signing out all other devices needs a passkey", { tag: ["@browser"] }, async ({ server, page, context, browser }) => {
  // Given the owner is signed in on a laptop and a phone
  const srv = await server({ host: "localhost", adminSocket: true });
  const owner = await bootstrapOwner(srv);
  const phoneKey = await addSecondPasskey(srv, owner);
  await signInBrowser(srv, owner, page, context);
  const phoneCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  try {
    const phone = await phoneCtx.newPage();
    await signInWith(srv, phoneKey, phone, phoneCtx);
    await phone.goto(`${srv.origin}/chats`);
    await expect(phone.getByRole("heading", { name: "Conversations", level: 1 })).toBeVisible();

    // When the owner signs out all other devices from the laptop with a passkey
    await page.goto(`${srv.origin}/settings/privacy`);
    await page.getByRole("button", { name: /^Sign out all other devices/ }).click();
    const sheet = page.getByRole("dialog", { name: "Sign out all other devices" });
    await sheet.getByRole("button", { name: "Sign out", exact: true }).click();
    await expect(sheet).toBeHidden();

    // Then the phone shows sign in on its next request
    await phone.goto(`${srv.origin}/chats`);
    await expect(phone.getByRole("heading", { name: "Sign in", level: 1 })).toBeVisible();
    // (the laptop, which asked, stays signed in)
    await page.reload();
    await expect(page.getByRole("heading", { name: "Privacy & security", level: 1 })).toBeVisible();
  } finally {
    await phoneCtx.close();
  }
});
