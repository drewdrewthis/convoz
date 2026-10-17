import { chatWorld } from "../lib/chat.ts";
import { Client } from "../lib/http.ts";
import { allow, loginMachine, signInBrowser } from "../lib/machines.ts";
import { addSecondPasskey } from "../lib/mobile.ts";
import { must, signIn } from "../lib/owner.ts";
import { decrypt, newSub, received, subBody } from "../lib/push-wp14.ts";
import { expect, scenario } from "../lib/scenario.ts";

// Binding of security.feature "A valid reveal shows the key once and leaves a trail". The reveal is the real flow of Crew -> Machines
// (a button opens a dialog "Reveal <machine>", its confirm button asks for the passkey, the key shows in a dialog "Key of <machine>").
// The owner's audit view is GET /api/admin/audit (the console has no audit screen yet, crew.feature). A second device of the owner has
// a push subscription on the fake push service of the test build.

scenario("A valid reveal shows the key once and leaves a trail", { tag: ["@browser", "@api"] }, async ({ server, page, context }, info) => {
  info.setTimeout(60_000);
  // Background: owner "drew" signed in with a virtual passkey, machines "box-2" and "laptop-1" logged in with the allow-list "devtool"
  const w = await chatWorld(server, { agents: ["devtool"] });
  await loginMachine(w.srv, w.owner, "laptop-1", allow("devtool"));
  const second = await addSecondPasskey(w.srv, w.owner);
  const other = new Client(w.srv.target); // another device of the owner, with push
  must(await signIn(other, second), "second device signs in");
  const sub = newSub();
  must(await other.post("/api/push/subscriptions", subBody(sub)), "second device subscribes", 201);
  await signInBrowser(w.srv, w.owner, page, context);

  // When the owner reveals the key of "box-2" with a passkey
  await page.goto(`${w.srv.origin}/crew/machines`);
  await page.getByRole("listitem").filter({ hasText: "box-2" }).getByRole("button", { name: "Reveal", exact: true }).click();
  await page.getByRole("dialog", { name: "Reveal box-2" }).getByRole("button", { name: "Reveal", exact: true }).click();

  // Then the key is shown once with a copy button and the hint "Paste into convoz login --stdin on the machine, never into an agent prompt."
  const sheet = page.getByRole("dialog", { name: "Key of box-2" });
  await expect(sheet.getByLabel("Machine key")).toContainText(w.box2.key);
  await expect(sheet.getByRole("button", { name: "Copy key" })).toBeVisible();
  await expect(sheet).toContainText("Paste into convoz login --stdin on the machine, never into an agent prompt.");
  await sheet.getByRole("button", { name: "Done" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole("heading", { name: "Machines" })).toBeVisible();
  await expect(page.locator("body")).not.toContainText(w.box2.key);

  // And the owner's audit view lists one "key revealed · box-2"
  const audit = must(await w.owner.client.get("/api/admin/audit"), "audit view").json().audit as { action: string; target_kind: string; target_id: number }[];
  expect(audit.filter((r) => r.action === "machine.key_revealed" && r.target_kind === "machine" && r.target_id === w.box2.id)).toHaveLength(1);
  expect(audit.filter((r) => r.action === "machine.key_revealed")).toHaveLength(1);

  // And every other device of the owner gets the push "Key revealed · box-2"
  await expect.poll(async () => (await received(w.srv)).filter((p) => p.endpoint === sub.endpoint).length, { timeout: 15_000 }).toBeGreaterThan(0);
  await new Promise((r) => setTimeout(r, 800));
  const shown = (await received(w.srv)).filter((p) => p.endpoint === sub.endpoint).map((p) => decrypt(sub, p));
  expect(shown.map((p) => p.title)).toEqual(["Key revealed · box-2"]);
  expect(shown[0]!.reason).toBe("security");
  expect(JSON.stringify(shown)).not.toContain(w.box2.key);
});
