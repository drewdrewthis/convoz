import { bootstrapOwner, must } from "../lib/owner.ts";
import { decrypt, newSub, received, subscribe } from "../lib/push-wp14.ts";
import { mainNav } from "../lib/chat-ui.ts";
import { expect, scenario } from "../lib/scenario.ts";

// Binding of onboarding.feature "A recovery code lets the owner add a new passkey only". /recover takes the code (textbox "Recovery code",
// button "Use code") and then offers one action, the button "Add a passkey". The owner's other device is the signed-in API client of the
// bootstrap, with a push subscription on the fake push service of the test build.

scenario("A recovery code lets the owner add a new passkey only", { tag: ["@browser"] }, async ({ server, page }) => {
  // Given the owner lost every passkey (this browser has none), and has another device that takes pushes
  const srv = await server({ host: "localhost", adminSocket: true, env: { CONVOZ_TEST_POLL_MS: "250" } });
  const owner = await bootstrapOwner(srv);
  const sub = newSub();
  must(await subscribe(owner, sub), "the other device subscribes", 201);

  // When the owner enters a recovery code
  await page.goto(`${srv.origin}/recover`);
  await page.getByRole("textbox", { name: "Recovery code" }).fill(owner.codes[0]!);
  await page.getByRole("button", { name: "Use code" }).click();

  // Then the app offers only "Add a passkey"
  await expect(page.getByText("Code accepted. Add a passkey on this device to finish.")).toBeVisible();
  await expect(page.getByRole("button")).toHaveText(["Add a passkey"]);
  await expect(mainNav(page)).toHaveCount(0);
  const asked = await page.request.get(`${srv.origin}/api/conversations`);
  expect(asked.status(), "the limited device may not read anything else").toBeGreaterThanOrEqual(400);

  // And every other device gets the push "Recovery code used" and an offer to sign out all other devices
  await expect.poll(async () => (await received(srv)).filter((p) => p.endpoint === sub.endpoint).length, { timeout: 15_000 }).toBeGreaterThan(0);
  await new Promise((r) => setTimeout(r, 800));
  const shown = (await received(srv)).filter((p) => p.endpoint === sub.endpoint).map((p) => decrypt(sub, p));
  expect(shown.map((p) => p.title)).toEqual(["Recovery code used"]);
  expect(shown[0]!.body).toContain("Sign out all other devices");
  expect(shown[0]!.url).toBe("/settings/privacy");
});
