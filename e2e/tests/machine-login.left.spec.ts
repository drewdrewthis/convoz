import fs from "node:fs";
import type { Page } from "@playwright/test";
import { asDevtool, briefWorld, type BriefWorld } from "../lib/agent-wp7.ts";
import { installedMachine } from "../lib/cli.ts";
import { signInBrowser } from "../lib/machines.ts";
import { expect, scenario } from "../lib/scenario.ts";

// Bindings of machine-login.feature "A lost credential costs nothing but a reveal or a new login" (AC-15). The Crew -> Machines page is
// /crew/machines: one row per machine with the buttons Reveal, Regenerate, Revoke and "Edit allow-list"; a button opens a dialog named
// "<Button> <machine>" whose confirm button asks for the passkey; the key then shows once in a dialog "Key of <machine>" as the
// output "Machine key". "The owner approves a real machine from the phone" stays @needs-owner: it needs a real tailnet machine and a phone.

const machineRow = (page: Page, name: string) => page.getByRole("listitem").filter({ hasText: name });

/** Press `button` on the machine's row, confirm with the passkey and read the key the dialog shows. */
async function keyFrom(page: Page, machine: string, button: "Reveal" | "Regenerate"): Promise<string> {
  await machineRow(page, machine).getByRole("button", { name: button, exact: true }).click();
  await page.getByRole("dialog", { name: `${button} ${machine}` }).getByRole("button", { name: button, exact: true }).click();
  const shown = page.getByRole("dialog", { name: `Key of ${machine}` }).getByLabel("Machine key");
  await expect(shown).toContainText("cvz_m_");
  const key = ((await shown.textContent()) ?? "").trim();
  await page.getByRole("dialog", { name: `Key of ${machine}` }).getByRole("button", { name: "Done" }).click();
  return key;
}

/** "Allowed: devtool, docs." from the row's line, without the counts that move (live sessions). */
const allowOf = (line: string | null): string => /^Allowed: [^.]*\./.exec(line ?? "")?.[0] ?? "";

/** The brief as sections; the first one names this very session, so it is left out of a comparison. */
async function sectionsOf(w: BriefWorld, label: string): Promise<{ key: string; text: string }[]> {
  const res = await asDevtool(w, label, ["brief", "--json"]);
  expect(res.code, res.stderr).toBe(0);
  return (JSON.parse(res.stdout).sections as { key: string; text: string }[]).filter((s) => s.key !== "identity");
}

scenario("Reveal and login with stdin restore the same agent state", { tag: ["@cli", "@browser"] }, async ({ server, dataDir, page, context }) => {
  // Given "devtool" on "box-2" has unread items, an unacked answer, an open ask, a handoff note and read positions
  const w = await briefWorld({ server, dataDir });

  // And the output of "convoz brief --as devtool" is saved
  const saved = await sectionsOf(w, "saved");
  expect(saved.map((s) => s.key)).toEqual(["handoff", "answers", "asks", "inbox", "conversations", "decisions", "expired"]);
  await signInBrowser(w.srv, w.owner, page, context);

  // When the credentials file on "box-2" is deleted
  fs.unlinkSync(w.box.credentialsPath);
  expect((await w.box.whoami()).code).not.toBe(0);

  // And the owner reveals the key of "box-2" with a passkey
  await page.goto(`${w.srv.origin}/crew/machines`);
  const key = await keyFrom(page, "box-2", "Reveal");
  expect(key).toBe(w.box2.key);

  // And the revealed key is piped into "convoz login --stdin"
  const login = await w.box.install(w.srv.origin, "box-2", key);
  expect(login.code, login.stderr).toBe(0);

  // Then "convoz brief --as devtool" shows the same sections as the saved brief
  expect(await sectionsOf(w, "restored")).toEqual(saved);
});

scenario("Regenerating a lost key keeps the agent state", { tag: ["@cli", "@browser"] }, async ({ server, dataDir, page, context }) => {
  // Given machine "box-2" lost its credentials file
  const w = await briefWorld({ server, dataDir });
  const before = await sectionsOf(w, "before");
  const oldKeyHolder = await installedMachine(w.srv.origin, "box-2", w.box2.key); // a copy of the lost file, to try the old key with later
  await signInBrowser(w.srv, w.owner, page, context);
  fs.unlinkSync(w.box.credentialsPath);
  await page.goto(`${w.srv.origin}/crew/machines`);
  const allowBefore = allowOf(await machineRow(page, "box-2").getByText(/^Allowed:/).textContent());

  // When the owner regenerates the key of "box-2" with a passkey
  const fresh = await keyFrom(page, "box-2", "Regenerate");
  expect(fresh).not.toBe(w.box2.key);

  // And the new key is piped into "convoz login --stdin" on "box-2"
  const login = await w.box.install(w.srv.origin, "box-2", fresh);
  expect(login.code, login.stderr).toBe(0);

  // Then "convoz brief --as devtool" shows the same sections as before the loss
  expect(await sectionsOf(w, "after")).toEqual(before);

  // And Crew → Machines shows the same allow-list for "box-2"
  await page.reload();
  await expect(machineRow(page, "box-2").getByText(/^Allowed:/)).toContainText(allowBefore);

  // And a command that still uses the old key exits 3
  const stale = await asDevtool({ ...w, box: oldKeyHolder }, "stale", ["brief"]);
  expect(stale.code).toBe(3);
});
