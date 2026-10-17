import { agentSays, convoz, createConversation, startSession } from "../lib/chat.ts";
import { crewRow, crewWorld, disableAgent, labelledSession, ringStyle, sheetNamed, tokenColor } from "../lib/crew-wp9.ts";
import { allow, stepped } from "../lib/machines.ts";
import { expect, scenario } from "../lib/scenario.ts";
import { seedAsk, seedDb } from "../lib/wp3.ts";

/*
 * crew.feature, the owner's side of Crew in the browser (WP9). Page contract (role, name and text locators only):
 *   /crew              button "Add agent"; groups "Waiting on you", "Working", "Idle" (a list each, "· N" in the heading; an agent with no live
 *                      session is Idle with the label "Offline" and a ring named "hollow grey dot"); a disclosure "Disabled · N" opens the
 *                      disabled agents. A row is a link to /crew/<handle>: ring (role img, named by its look), "Display Name @handle" (the handle
 *                      alone when the display name repeats it) and the status line "Working · <doing>".
 *   /crew/<handle>     "Waiting on you · N" and "Conversations together · N" (links), tabs "Sessions" and "Handoffs", link "New conversation with
 *                      @<handle>", button "Disable" (a passkey sheet "Disable @<handle>").
 *   /crew/machines     a listitem per machine: "<n> live sessions · last used <x> ago", "Allowed: ...", button "Edit allow-list".
 * The step-ups are real: each sheet takes the passkey by itself when its button is pressed.
 */

const HANDOFF_NOTES = ["First note: schema ready", "Second note: tests 3 and 7 flaky", "Third note: open the PR"];

// ---- Rule: The owner creates identities; names are unique and never reused ------------------------------------------------------

scenario("Adding an agent on a machine that already allows it", { tag: ["@browser"] }, async ({ server, page, context }) => {
  // Given "box-2" has allow mode "any"
  const c = await crewWorld({ server, page, context }, {
    agents: ["devtool"],
    beforeSignIn: async (x) => void (await stepped(x.w.owner, "PATCH", `/api/machines/${x.w.box2.id}`, { allow: { mode: "any", identities: [], globs: [] } }, "machine.allow", x.w.box2.id)),
  });
  await page.goto(`${c.w.srv.origin}/crew`);

  // When the owner adds agent "dev-search" named "Search Dev" with a passkey
  await page.getByRole("button", { name: /^(Add|Invite) agent$/ }).click();
  const add = sheetNamed(page, "Add agent");
  await add.getByRole("textbox", { name: "Handle" }).fill("dev-search");
  await add.getByRole("textbox", { name: "Display name" }).fill("Search Dev");
  await add.getByRole("button", { name: "Add agent" }).click();

  // Then the sheet shows the one-line prompt "You're @dev-search on Convoz. Run convoz brief first."
  const done = sheetNamed(page, "@dev-search added");
  await expect(done.getByText("You're @dev-search on Convoz. Run convoz brief first.", { exact: true })).toBeVisible();

  // And the sheet shows no key and no string starting with "cvz_"
  await expect(done).not.toContainText("cvz_");
  await expect(done.getByText("Allow on machine…")).toHaveCount(0);

  // And Crew shows "Search Dev @dev-search"
  await done.getByRole("button", { name: "Done" }).click();
  await expect(page.getByText("Search Dev @dev-search", { exact: true })).toBeVisible();
});

scenario("Adding an agent that no machine allows yet", { tag: ["@browser"] }, async ({ server, page, context }) => {
  // Background: "box-2" allows "devtool" only
  const c = await crewWorld({ server, page, context }, { agents: ["devtool"] });
  await page.goto(`${c.w.srv.origin}/crew`);
  expect((await c.w.box.sessionStart("docs")).code).not.toBe(0);

  // When the owner adds agent "docs" named "Docs" with a passkey
  await page.getByRole("button", { name: /^(Add|Invite) agent$/ }).click();
  const add = sheetNamed(page, "Add agent");
  await add.getByRole("textbox", { name: "Handle" }).fill("docs");
  await add.getByRole("textbox", { name: "Display name" }).fill("Docs");
  await add.getByRole("button", { name: "Add agent" }).click();

  // Then the sheet offers "Allow on machine…" with "box-2"
  const done = sheetNamed(page, "@docs added");
  await expect(done.getByText("Allow on machine…")).toBeVisible();
  await expect(done.getByRole("button", { name: "box-2", exact: true })).toBeVisible();

  // And it shows the command "convoz login" for a new machine
  await expect(done.getByText("convoz login", { exact: true })).toBeVisible();
  await expect(done).not.toContainText("cvz_");

  // And choosing "box-2" lets "convoz session start --as docs" work there
  await done.getByRole("button", { name: "box-2", exact: true }).click();
  await sheetNamed(page, "Allow @docs on box-2").getByRole("button", { name: "Allow", exact: true }).click();
  await expect(done.getByText("You're @docs on Convoz. Run convoz brief first.")).toBeVisible();
  const started = await c.w.box.sessionStart("docs");
  expect(started.code, started.stderr).toBe(0);
});

scenario("A handle is never used again", { tag: ["@browser"] }, async ({ server, page, context }) => {
  // Given the owner disabled the agent "release-bot", which had posted in a conversation
  const c = await crewWorld({ server, page, context }, {
    agents: ["devtool", "release-bot"],
    live: ["release-bot"],
    beforeSignIn: async (x) => {
      const conv = await createConversation(x.w.owner, { participants: ["release-bot"], title: "Ship search filters" });
      await agentSays(x.w.srv, x.sessions["release-bot"]!.lease, conv, "Released v1");
      await disableAgent(x, "release-bot");
    },
  });
  await page.goto(`${c.w.srv.origin}/crew`);

  // When the owner tries to add a new agent with the handle "release-bot"
  await page.getByRole("button", { name: /^(Add|Invite) agent$/ }).click();
  const add = sheetNamed(page, "Add agent");
  await add.getByRole("textbox", { name: "Handle" }).fill("release-bot");
  await add.getByRole("textbox", { name: "Display name" }).fill("Release Bot 2");
  await add.getByRole("button", { name: "Add agent" }).click();

  // Then the add sheet says the handle "release-bot" was used before
  await expect(add.getByRole("alert")).toContainText('The handle "release-bot" was used before');
  await add.getByRole("button", { name: "Cancel" }).click();

  // And Crew still lists the disabled "release-bot" with its old messages
  await page.getByRole("button", { name: /^Disabled · 1/ }).click();
  const row = crewRow(page, "release-bot");
  await expect(row).toBeVisible();
  await expect(row).toContainText("Disabled");
  await row.click();
  await page.getByRole("region", { name: "Conversations together" }).getByRole("link", { name: "Ship search filters" }).click();
  await expect(page.getByRole("log", { name: "Messages" }).getByRole("article").filter({ hasText: "Released v1" })).toContainText("release-bot");
});

scenario("The handle always shows next to an agent's display name", { tag: ["@browser"] }, async ({ server, dataDir, page, context }) => {
  // Given "devtool" set its display name to "Drew"
  const c = await crewWorld({ server, page, context }, { agents: ["devtool"], live: ["devtool"], plaintext: true });
  // The owner is "Drew" too, so the lookalike rule refuses this name over the API; the row is written the way an older build could have.
  seedDb(dataDir, (db) => db.prepare("UPDATE identities SET display_name = 'Drew' WHERE handle = 'devtool'").run());
  const conv = await createConversation(c.w.owner, { participants: ["devtool"], title: "Ship search filters" });
  await agentSays(c.w.srv, c.sessions.devtool!.lease, conv, "Hello from the agent");

  // When the owner views a message from "devtool"
  await page.goto(`${c.w.srv.origin}/chats/${conv}`);

  // Then the author reads "Drew @devtool"
  const article = page.getByRole("log", { name: "Messages" }).getByRole("article").filter({ hasText: "Hello from the agent" });
  await expect(article.getByText("Drew @devtool", { exact: true })).toBeVisible();
});

scenario("Identities are disabled, never deleted", { tag: ["@browser"] }, async ({ server, page, context }) => {
  // Given "devtool" posted in a conversation
  const c = await crewWorld({ server, page, context }, { agents: ["devtool"], live: ["devtool"] });
  const conv = await createConversation(c.w.owner, { participants: ["devtool"], title: "Ship search filters" });
  await agentSays(c.w.srv, c.sessions.devtool!.lease, conv, "Old message");

  // When the owner disables "devtool" with a passkey
  await page.goto(`${c.w.srv.origin}/crew/devtool`);
  await expect(page.getByRole("button", { name: /delete/i })).toHaveCount(0);
  await page.getByRole("button", { name: "Disable", exact: true }).click();
  await sheetNamed(page, "Disable @devtool").getByRole("button", { name: "Disable", exact: true }).click();
  await expect(sheetNamed(page, "Disable @devtool")).toBeHidden();

  // Then Crew lists "devtool" as disabled
  await page.goto(`${c.w.srv.origin}/crew`);
  await page.getByRole("button", { name: /^Disabled · 1/ }).click();
  await expect(crewRow(page, "devtool")).toContainText("Disabled");

  // And its old messages still show "@devtool"
  await page.goto(`${c.w.srv.origin}/chats/${conv}`);
  await expect(page.getByRole("log", { name: "Messages" }).getByRole("article").filter({ hasText: "Old message" })).toContainText("@devtool");

  // And Crew offers no way to delete "devtool"
  await page.goto(`${c.w.srv.origin}/crew/devtool`);
  await expect(page.getByRole("heading", { name: "devtool" })).toBeVisible();
  await expect(page.getByRole("button", { name: /delete|remove/i })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Disable", exact: true })).toHaveCount(0);
});

// ---- Rule: Disabling an identity cuts every session at once (I-38) --------------------------------------------------------------

scenario("Disabling an identity ends its sessions and closes its asks", { tag: ["@browser", "@cli"] }, async ({ server, dataDir, page, context }) => {
  // Given "devtool" has sessions on "box-2" and an open ask in conversation 41
  let conv = 0;
  let ask = 0;
  const c = await crewWorld({ server, page, context }, {
    agents: ["devtool"],
    plaintext: true,
    beforeSignIn: async (x) => {
      conv = await createConversation(x.w.owner, { participants: ["devtool"], title: "Ship search filters" });
      ask = seedAsk(dataDir, conv, x.ids.devtool!, x.ids.drew!, "Deploy to production?", "open");
    },
  });
  const first = await labelledSession(c.w.box, "devtool", "claude-7f3a");
  const second = await labelledSession(c.w.box, "devtool", "claude-91bc");
  expect((await convoz(c.w.box, first, ["read", String(conv)])).code).toBe(0);

  // When the owner disables "devtool" with a passkey
  await page.goto(`${c.w.srv.origin}/crew/devtool`);
  await page.getByRole("button", { name: "Disable", exact: true }).click();
  await sheetNamed(page, "Disable @devtool").getByRole("button", { name: "Disable", exact: true }).click();
  await expect(page.getByText("Disabled", { exact: true })).toBeVisible();

  // Then the next command of each "devtool" session exits 3 with a message that the identity was disabled
  for (const sid of [first, second]) {
    const res = await convoz(c.w.box, sid, ["read", String(conv)]);
    expect(res.code, res.stderr).toBe(3);
    expect(res.stderr).toMatch(/disabled/i);
  }

  // And the ask shows "Closed"
  await page.goto(`${c.w.srv.origin}/chats/${conv}`);
  await expect(page.getByRole("log", { name: "Messages" }).getByText("Closed", { exact: true })).toBeVisible();
  expect(seedDb(dataDir, (db) => db.prepare("SELECT state FROM asks WHERE message_id = ?").get(ask))).toEqual({ state: "closed" });

  // And Crew shows "devtool" as disabled
  await page.goto(`${c.w.srv.origin}/crew`);
  await page.getByRole("button", { name: /^Disabled · 1/ }).click();
  await expect(crewRow(page, "devtool")).toContainText("Disabled");
});

// ---- Rule: The owner manages machines and their allow-lists --------------------------------------------------------------------

scenario("Crew lists machines with their state", { tag: ["@browser"] }, async ({ server, dataDir, page, context }) => {
  // Given "box-2" has 3 live sessions and was last used 2 minutes ago
  const c = await crewWorld({ server, page, context }, {
    agents: ["devtool"],
    plaintext: true,
    beforeSignIn: async (x) => {
      for (const label of ["claude-aaaa", "claude-bbbb", "claude-cccc"]) await labelledSession(x.w.box, "devtool", label);
      seedDb(dataDir, (db) => db.prepare("UPDATE machines SET last_used_at = ? WHERE name = 'box-2'").run(Date.now() - 2 * 60_000));
    },
  });

  // When the owner opens Crew → Machines
  await page.goto(`${c.w.srv.origin}/crew`);
  await page.getByRole("link", { name: "Machines" }).first().click();

  // Then "box-2" shows its key hint, allow-list, "3 live sessions" and "last used 2 min ago"
  const row = page.getByRole("listitem").filter({ hasText: "box-2" });
  const hint = (await c.w.owner.client.get("/api/machines")).json().machines[0].key_hint as string;
  await expect(row).toContainText(hint);
  await expect(row).toContainText("Allowed: devtool");
  await expect(row).toContainText("3 live sessions");
  await expect(row).toContainText("last used 2 min ago");
});

scenario("Editing a machine's allow-list needs a passkey", { tag: ["@browser"] }, async ({ server, page, context }) => {
  // Background: "box-2" allows "devtool" only, and "docs" exists
  const c = await crewWorld({ server, page, context }, { agents: ["devtool", "docs"], allowed: ["devtool"] });
  expect((await c.w.box.sessionStart("docs")).code).not.toBe(0);
  const steps: string[] = [];
  page.on("request", (r) => {
    if (r.method() === "PATCH" && r.url().endsWith(`/api/machines/${c.w.box2.id}`)) steps.push(r.headers()["x-convoz-step-up"] ?? "");
    if (r.url().endsWith("/api/auth/step-up/options")) steps.push("passkey asked");
  });
  await page.goto(`${c.w.srv.origin}/crew/machines`);
  await expect(page.getByRole("listitem").filter({ hasText: "box-2" })).toContainText("0 live sessions");

  // When the owner adds "docs" to the allow-list of "box-2"
  await page.getByRole("button", { name: "Edit allow-list" }).click();
  const sheet = sheetNamed(page, "Allow-list of box-2");
  await sheet.getByRole("textbox", { name: "Allowed identities" }).fill("devtool, docs");
  await sheet.getByRole("button", { name: "Save" }).click();

  // Then the app asks for a passkey first
  await expect(page.getByText("Allowed: devtool, docs")).toBeVisible();
  const saved = steps.findIndex((s) => /^\d+$/.test(s));
  expect(saved, steps.join()).toBeGreaterThan(0);
  expect(steps.slice(0, saved)).toContain("passkey asked");

  // And after it, "convoz session start --as docs" works on "box-2"
  const started = await c.w.box.sessionStart("docs");
  expect(started.code, started.stderr).toBe(0);
});

scenario("Crew lists live sessions with label and machine", { tag: ["@browser"] }, async ({ server, page, context }) => {
  // Given "devtool" has sessions "claude-7f3a" and "claude-91bc" on "box-2"
  const c = await crewWorld({ server, page, context }, { agents: ["devtool", "docs"], live: ["docs"] });
  await labelledSession(c.w.box, "devtool", "claude-7f3a");
  await labelledSession(c.w.box, "devtool", "claude-91bc");

  // When the owner opens Crew → devtool → Sessions
  await page.goto(`${c.w.srv.origin}/crew`);
  await crewRow(page, "devtool").click();
  await page.getByRole("tab", { name: "Sessions" }).click();

  // Then both sessions show with their label, machine and last seen time
  const list = page.getByRole("list", { name: "Sessions" });
  await expect(list.getByRole("listitem")).toHaveCount(2);
  for (const label of ["claude-7f3a", "claude-91bc"]) {
    const item = list.getByRole("listitem").filter({ hasText: label });
    await expect(item).toContainText("on box-2");
    await expect(item).toContainText("last seen");
  }
});

scenario("The owner reads an agent's handoff notes", { tag: ["@browser"] }, async ({ server, page, context }) => {
  // Given "devtool" stored 3 handoff notes
  const c = await crewWorld({ server, page, context }, { agents: ["devtool"] });
  for (const [i, note] of HANDOFF_NOTES.entries()) {
    const sid = await labelledSession(c.w.box, "devtool", `claude-note${i}`);
    const res = await convoz(c.w.box, sid, ["handoff", note]);
    expect(res.code, res.stderr).toBe(0);
  }

  // When the owner opens Crew → devtool → Handoffs
  await page.goto(`${c.w.srv.origin}/crew/devtool`);
  await page.getByRole("tab", { name: "Handoffs" }).click();

  // Then the 3 notes show newest first with session and machine
  const items = page.getByRole("list", { name: "Handoff notes" }).getByRole("listitem");
  await expect(items).toHaveCount(3);
  for (const [i, note] of [...HANDOFF_NOTES].reverse().entries()) {
    await expect(items.nth(i)).toContainText(note);
    await expect(items.nth(i)).toContainText(`claude-note${HANDOFF_NOTES.indexOf(note)} on box-2`);
  }
});

// ---- Rule: Agents describe themselves, within limits ---------------------------------------------------------------------------

scenario("The status ring tells the agent's state without colour alone", { tag: ["@browser"] }, async ({ server, page, context }) => {
  const c = await crewWorld({ server, page, context }, { agents: ["devtool"], live: ["devtool"] });
  const sid = c.sessions.devtool!.sid;
  const rows = [
    { state: "working", label: "working", ring: "moving gradient ring" },
    { state: "waiting", label: "waiting on you", ring: "amber ring" },
    { state: "idle", label: "idle", ring: "grey ring" },
    { state: "offline", label: "offline", ring: "hollow grey dot" },
  ];
  for (const { state, label, ring } of rows) {
    // Given "devtool" has the status "<state>" (offline: its session ended)
    if (state === "offline") expect((await c.w.box.sessionEnd(sid)).code).toBe(0);
    else expect((await convoz(c.w.box, sid, ["status", "--state", state])).code).toBe(0);

    // When the owner opens Crew
    await page.goto(`${c.w.srv.origin}/crew`);

    // Then "devtool" shows the label "<label>" and a <ring>
    const row = crewRow(page, "devtool");
    await expect(row).toContainText(label, { ignoreCase: true });
    const mark = row.getByRole("img", { name: ring });
    await expect(mark).toBeVisible();
    if (state === "working") expect(await ringStyle(mark, "::before", "animation-name")).not.toBe("none");
    else expect(await ringStyle(mark, "::before", "animation-name")).toBe("none");
    if (state === "waiting") expect(await ringStyle(mark, "::before", "background-color")).toBe(await tokenColor(page, "--color-amber"));
    if (state === "idle") expect(await ringStyle(mark, "::before", "background-color")).toBe(await tokenColor(page, "--color-idle"));
    if (state === "offline") expect(await ringStyle(mark, "::after", "border-top-width")).not.toBe("0px");
  }
});

scenario("An agent profile shows what waits on the owner and shared conversations", { tag: ["@browser"] }, async ({ server, dataDir, page, context }) => {
  // Given "devtool" has 2 open asks and shares 4 conversations with the owner
  const titles = ["Ship search filters", "Deploy alerts runbook", "Weekly usage", "Bug #8642"];
  const c = await crewWorld({ server, page, context }, {
    agents: ["devtool", "docs"],
    plaintext: true,
    beforeSignIn: async (x) => {
      const convs: number[] = [];
      for (const title of titles) convs.push(await createConversation(x.w.owner, { participants: ["devtool"], title }));
      await createConversation(x.w.owner, { participants: ["docs"], title: "Docs only" });
      seedAsk(dataDir, convs[0]!, x.ids.devtool!, x.ids.drew!, "Deploy to production?", "open");
      seedAsk(dataDir, convs[1]!, x.ids.devtool!, x.ids.drew!, "Use the small runner?", "open");
    },
  });

  // When the owner opens the profile of "devtool"
  await page.goto(`${c.w.srv.origin}/crew`);
  await crewRow(page, "devtool").click();

  // Then "Waiting on you · 2" and "Conversations together" list them
  await expect(page.getByText("Waiting on you · 2", { exact: true })).toBeVisible();
  const waiting = page.getByRole("region", { name: "Waiting on you" });
  await expect(waiting.getByRole("link")).toHaveText(["Use the small runner?", "Deploy to production?"]);
  const together = page.getByRole("region", { name: "Conversations together" });
  await expect(page.getByText("Conversations together · 4", { exact: true })).toBeVisible();
  for (const title of titles) await expect(together.getByRole("link", { name: title })).toBeVisible();
  await expect(together.getByRole("link", { name: "Docs only" })).toHaveCount(0);

  // And "New conversation with @devtool" starts a conversation with "devtool" in it
  await page.getByRole("link", { name: "New conversation with @devtool" }).click();
  await expect(page.getByRole("textbox", { name: "Message @devtool" })).toBeVisible();
});
