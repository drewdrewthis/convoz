import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CliMachine } from "../lib/cli.ts";
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

const inviteButton = (page: import("@playwright/test").Page) => page.getByRole("button", { name: /^(Add|Invite) agent$/ }).first();
const AVATAR_JS = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><script>alert(1)</script><circle cx="5" cy="5" r="4" fill="blue"/></svg>';

scenario("The invite sheet is one prompt with no form and no secret", { tag: ["@browser"] }, async ({ server, page, context }) => {
  const c = await crewWorld({ server, page, context }, { agents: ["devtool"] });
  await page.goto(`${c.w.srv.origin}/crew`);

  // When the owner opens Crew and taps "Invite agent"
  await inviteButton(page).click();

  // Then the sheet "Invite agent" shows a prompt with no field to fill in
  const sheet = sheetNamed(page, "Invite agent");
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole("textbox")).toHaveCount(0);

  // And the prompt names this server, the install line, "convoz login", "convoz session start" with "--create", and the brief, post, ask, status and app lines
  const prompt = sheet.getByLabel("Connect prompt");
  await expect(prompt).toContainText(c.w.srv.origin);
  await expect(prompt).toContainText(`command -v convoz >/dev/null || curl -fsSL ${c.w.srv.origin}/install | sh`);
  await expect(prompt).not.toContainText("go install");
  for (const part of ["command -v convoz", "convoz login --server", "convoz session start --as <your-handle> --create", "convoz brief", "convoz post", "convoz ask", "convoz status", "convoz post --app"]) await expect(prompt).toContainText(part);

  // And the prompt shows "--conversation" nowhere
  await expect(prompt).not.toContainText("--conversation");

  // And the sheet shows "Waiting for an agent to connect…"
  await expect(sheet.getByText("Waiting for an agent to connect…")).toBeVisible();

  // And the sheet shows no key and no string starting with "cvz_"
  await expect(sheet).not.toContainText("cvz_");
});

scenario("Adding an agent from a machine that is already logged in", { tag: ["@browser", "@cli"] }, async ({ server, page, context }) => {
  // Given "box-2" is logged in without the create_identity scope, and the owner opened the invite sheet in Crew
  const c = await crewWorld({ server, page, context }, { agents: ["devtool"] });
  await page.goto(`${c.w.srv.origin}/crew`);
  await inviteButton(page).click();
  const sheet = sheetNamed(page, "Invite agent");
  await expect(sheet.getByText("Waiting for an agent to connect…")).toBeVisible();

  // When the agent runs the prompt's "convoz session start --as code-review --create --description 'Reviews pull requests'" on "box-2"
  const run = c.w.box.start(["session", "start", "--as", "code-review", "--create", "--description", "Reviews pull requests"]);

  // Then the sheet shows the request card "box-2 wants to connect as @code-review" with "Reviews pull requests"
  const card = sheet.getByRole("article", { name: "box-2 wants to connect as @code-review", exact: true });
  await expect(card).toContainText("Reviews pull requests");

  // When the owner taps Approve on the card in the sheet
  await card.getByRole("button", { name: "Approve", exact: true }).click();

  // Then the sheet says "Connected: code-review is online."
  await expect(sheet.getByText("Connected: code-review is online.")).toBeVisible();

  // And the sheet offers "New thread with code-review" and "Done"
  await expect(sheet.getByRole("link", { name: "New thread with code-review" })).toBeVisible();
  await expect(sheet.getByRole("button", { name: "Done" })).toBeVisible();
  expect((await run.done).code).toBe(0);

  // And Crew shows "code-review" with the line "Reviews pull requests"
  await sheet.getByRole("button", { name: "Done" }).click();
  await page.goto(`${c.w.srv.origin}/crew/code-review`);
  await expect(page.getByText("Reviews pull requests")).toBeVisible();
});

scenario("Adding an agent from a new machine", { tag: ["@browser", "@cli"] }, async ({ server, page, context }) => {
  // Given the owner opened the invite sheet in Crew
  const c = await crewWorld({ server, page, context }, { agents: ["devtool"] });
  await page.goto(`${c.w.srv.origin}/crew`);
  await inviteButton(page).click();
  const sheet = sheetNamed(page, "Invite agent");

  // When the agent runs the prompt's "convoz login --name box-5 --as code-review" on a new machine
  const fresh = new CliMachine();
  const login = fresh.startLogin(c.w.srv.origin, "box-5", ["--as", "code-review"]);

  // Then the sheet shows the request card "box-5 wants to connect as @code-review" with the code
  const card = sheet.getByRole("article", { name: "box-5 wants to connect as @code-review", exact: true });
  await expect(card).toContainText(/Code: [A-Z]{4}-[A-Z]{4}/);

  // When the owner taps Approve on the card in the sheet
  await card.getByRole("button", { name: "Approve", exact: true }).click();

  // Then the sheet says "Connected: code-review is online."
  await expect(sheet.getByText("Connected: code-review is online.")).toBeVisible();
  expect((await login.done).code).toBe(0);

  // And "convoz session start --as code-review" works on "box-5"
  const started = await fresh.sessionStart("code-review");
  expect(started.code, started.stderr).toBe(0);
});

scenario("Inviting an agent from a conversation puts it in that conversation", { tag: ["@browser", "@cli"] }, async ({ server, page, context }) => {
  // Given the owner is in the conversation "Ship search filters"
  let conv = 0;
  const c = await crewWorld({ server, page, context }, {
    agents: ["devtool"],
    beforeSignIn: async (x) => void (conv = await createConversation(x.w.owner, { participants: ["devtool"], title: "Ship search filters" })),
  });
  await page.goto(`${c.w.srv.origin}/chats/${conv}`);

  // When the owner types "@" in the message box and taps "Invite a new agent…"
  await page.getByRole("textbox", { name: /^Message/ }).fill("@");
  await page.getByRole("option", { name: "Invite a new agent…" }).or(page.getByRole("button", { name: "Invite a new agent…" })).first().click();

  // Then the sheet says the agent joins "Ship search filters"
  const sheet = sheetNamed(page, "Invite agent");
  await expect(sheet).toContainText("It joins “Ship search filters”.");

  // And the prompt carries that conversation for "--conversation"
  await expect(sheet.getByLabel("Connect prompt")).toContainText(`--conversation ${conv}`);

  // When the agent runs the prompt's "convoz login --name box-5 --as code-review --conversation" with that conversation on a new machine
  const login = new CliMachine().startLogin(c.w.srv.origin, "box-5", ["--as", "code-review", "--conversation", String(conv)]);

  // And the owner taps Approve on the card
  await sheet.getByRole("article", { name: "box-5 wants to connect as @code-review", exact: true }).getByRole("button", { name: "Approve", exact: true }).click();

  // Then the sheet says "Connected: code-review is online and in “Ship search filters”."
  await expect(sheet.getByText("Connected: code-review is online and in “Ship search filters”.")).toBeVisible();
  expect((await login.done).code).toBe(0);

  // And "code-review" is a participant of "Ship search filters" and sees the whole history
  const members = (await c.w.owner.client.get(`/api/conversations/${conv}`)).json().conversation.participants as { handle: string }[];
  expect(members.map((m) => m.handle)).toContain("code-review");
});

scenario("The details panel and the invite button in the rail open the same sheet", { tag: ["@browser"] }, async ({ server, page, context }) => {
  // Given the owner is in the conversation "Ship search filters"
  let conv = 0;
  const c = await crewWorld({ server, page, context }, {
    agents: ["devtool"],
    beforeSignIn: async (x) => void (conv = await createConversation(x.w.owner, { participants: ["devtool"], title: "Ship search filters" })),
  });
  await page.goto(`${c.w.srv.origin}/chats/${conv}`);

  // When the owner opens Details, taps "+ Add" and then "Invite a new agent"
  await page.getByRole("button", { name: "Show details" }).click();
  await page.getByRole("button", { name: "+ Add" }).click();
  await sheetNamed(page, "Add agent").getByRole("button", { name: "Invite a new agent" }).click();

  // Then the sheet "Invite agent" opens for that conversation
  await expect(sheetNamed(page, "Invite agent")).toContainText("Ship search filters");

  // When the owner taps the invite button in the rail
  await page.goto(`${c.w.srv.origin}/crew?invite`);

  // Then Crew opens with the sheet "Invite agent"
  await expect(sheetNamed(page, "Invite agent")).toBeVisible();
});

scenario("The Add agent prompt says how to ack", { tag: ["@browser"] }, async ({ server, page, context }) => {
  const c = await crewWorld({ server, page, context }, { agents: ["devtool"] });

  // When the owner opens the sheet "Invite agent"
  await page.goto(`${c.w.srv.origin}/crew?invite`);

  // Then the prompt on the Listen line says to ack each item with "convoz ack <id>:<token>"
  await expect(sheetNamed(page, "Invite agent").getByLabel("Connect prompt")).toContainText(
    "Listen:  convoz watch   (ack each item after you answer: convoz ack <id>:<token>)",
  );
});

scenario("The add-agent prompt tells the agent to start watching its inbox at once", { tag: ["@browser"] }, async ({ server, page, context }) => {
  const c = await crewWorld({ server, page, context }, { agents: ["devtool"] });

  // When the owner opens the sheet "Invite agent"
  await page.goto(`${c.w.srv.origin}/crew?invite`);

  // Then the watch line comes right after the connect lines and before "Then:"
  const prompt = sheetNamed(page, "Invite agent").getByLabel("Connect prompt");
  await expect(prompt).toContainText("convoz session start --as <your-handle> --create");
  const text = (await prompt.innerText()).replace(/\u00a0/g, " ");
  // @langwatch-technician, conv 19 msg 501: "The `--once` loop works for every agent, Monitor or not: run it in the background, answer, run it again."
  const watch = "Run `convoz watch --json --once` in the background. It exits when something arrives. Answer, ack, then run it again. Nothing is lost between runs: items stay in your inbox until you ack them.";
  const lines = text.split("\n");
  const at = lines.indexOf(watch);
  expect(at).toBeGreaterThan(-1);
  expect(lines[at - 2]).toContain("If this machine may not make identities");
  expect(lines[at + 2]).toContain("Then:  export CONVOZ_AS=<your-handle>");
});

scenario("The invite prompt explains post, reply, asks, apps and ack", { tag: ["@browser"] }, async ({ server, page, context }) => {
  const c = await crewWorld({ server, page, context }, { agents: ["devtool"] });

  // When the owner opens Crew and taps "Invite agent"
  await page.goto(`${c.w.srv.origin}/crew?invite`);

  // Then the prompt has a "How Convoz works" block
  const text = (await sheetNamed(page, "Invite agent").getByLabel("Connect prompt").innerText()).replace(/\u00a0/g, " ");
  const lesson = text.slice(text.indexOf("How Convoz works:"));
  expect(lesson).toContain("How Convoz works:");

  // And it says post is a normal answer and reply is a thread under one message
  expect(lesson).toContain("- Post is a normal answer in the conversation. Use it by default.");
  expect(lesson).toContain("- Reply is a thread under one message.");

  // And it says a watch item with a "thread_root_id" is answered with "convoz reply"
  expect(lesson).toContain("watch item has a thread_root_id");
  expect(lesson).toContain('convoz reply <thread_root_id> "..."');

  // And it says asks show as cards in the owner's feed and apps carry context
  expect(lesson).toContain("shows as a card in the owner's feed");
  expect(lesson).toContain("An app is a small card that carries context");

  // And it says to ack after answering and that status goes to the owner
  expect(lesson).toContain("convoz ack <ack>");
  expect(lesson).toContain("- Status goes to the owner, not to the chat.");
});

scenario("The install line survives a paste into Discord", { tag: ["@browser"] }, async ({ server, page, context }) => {
  const c = await crewWorld({ server, page, context }, { agents: ["devtool"] });

  // When the owner opens Crew and taps "Invite agent"
  await page.goto(`${c.w.srv.origin}/crew?invite`);
  const text = (await sheetNamed(page, "Invite agent").getByLabel("Connect prompt").innerText()).replace(/\u00a0/g, " ");

  // Then the install line and the connect commands sit inside code fences
  const fenced = [...text.matchAll(/^```\n([^\n]*)\n```$/gm)].map((m) => m[1]!);
  expect(fenced.some((l) => l.startsWith("command -v convoz >/dev/null || curl -fsSL "))).toBe(true);
  expect(fenced.some((l) => l.startsWith("convoz login --server "))).toBe(true);
  expect(fenced.some((l) => l.startsWith("convoz session start --as <your-handle> --create"))).toBe(true);

  // And no text outside a code fence holds "||"
  expect(text.replace(/^```\n[^\n]*\n```$/gm, "")).not.toContain("||");
});

scenario("What an agent says about itself shows as data", { tag: ["@browser", "@cli"] }, async ({ server, page, context }) => {
  // Given an agent sent the description "<b>bold</b> **stars** https://evil.example" and an SVG avatar with a script in it
  const c = await crewWorld({ server, page, context }, { agents: ["devtool"] });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "convoz-av-"));
  const svg = path.join(dir, "a.svg");
  fs.writeFileSync(svg, AVATAR_JS);
  const run = c.w.box.start(["session", "start", "--as", "code-review", "--create", "--description", "<b>bold</b> **stars** https://evil.example", "--avatar", svg]);

  // When the owner sees its request card
  await page.goto(c.w.srv.origin + "/");
  const card = page.getByRole("article", { name: "box-2 wants to connect as @code-review", exact: true });
  await expect(card).toBeVisible();

  // Then the card shows that description as plain text under "From the agent", on one line
  await expect(card).toContainText("From the agent");
  await expect(card.getByText("<b>bold</b> **stars** https://evil.example", { exact: true })).toBeVisible();
  await expect(card.locator("b, strong a, a")).toHaveCount(0);

  // And the machine name on the card is the server's own
  await expect(card.getByRole("heading")).toContainText("box-2");

  // And the avatar is an image of the cleaned SVG and runs no script
  const img = card.locator("img");
  await expect(img).toHaveAttribute("src", /^\/api\/identity-requests\/idr_[0-9a-f]{32}\/avatar\.svg$/);
  const served = await page.request.get(c.w.srv.origin + ((await img.getAttribute("src")) as string));
  expect(await served.text()).not.toContain("script");
  run.stop();
});

scenario("A handle is never used again", { tag: ["@browser", "@cli"] }, async ({ server, page, context }) => {
  // Given the owner revoked the key of the agent "release-bot", which had posted in a conversation
  const c = await crewWorld({ server, page, context }, {
    agents: ["devtool", "release-bot"],
    live: ["release-bot"],
    beforeSignIn: async (x) => {
      const conv = await createConversation(x.w.owner, { participants: ["release-bot"], title: "Ship search filters" });
      await agentSays(x.w.srv, x.sessions["release-bot"]!.lease, conv, "Released v1");
      await disableAgent(x, "release-bot");
    },
  });

  // When an agent runs "convoz login --name box-5 --as release-bot"
  const res = await new CliMachine().run(["login", "--server", c.w.srv.origin, "--name", "box-5", "--as", "release-bot"]);

  // Then the CLI exits 4 and says the handle is taken or was used before
  expect(res.code, res.stderr).toBe(4);
  expect(res.stderr).toMatch(/taken or was used before/i);

  // And Now shows no request card
  await page.goto(c.w.srv.origin + "/");
  await expect(page.getByRole("article")).toHaveCount(0);

  // And Crew still lists the disabled "release-bot" with its old messages
  await page.goto(`${c.w.srv.origin}/crew`);
  await page.getByRole("button", { name: /^Disabled · 1/ }).click();
  const row = crewRow(page, "release-bot");
  await expect(row).toContainText("Disabled");
  await row.click();
  await page.getByRole("region", { name: "Conversations together" }).getByRole("link", { name: "Ship search filters" }).click();
  await expect(page.getByRole("log", { name: "Messages" }).getByRole("article").filter({ hasText: "Released v1" })).toContainText("release-bot");
});

scenario("A look-alike of an existing name is refused", { tag: ["@browser", "@cli"] }, async ({ server, page, context }) => {
  // Given the agent "devtool" exists
  const c = await crewWorld({ server, page, context }, { agents: ["devtool"] });

  // When an agent runs "convoz login --name box-5 --as devtoo1"
  const res = await new CliMachine().run(["login", "--server", c.w.srv.origin, "--name", "box-5", "--as", "devtoo1"]);

  // Then the CLI says the handle looks like another identity's name
  expect(res.code, res.stderr).not.toBe(0);
  expect(res.stderr).toMatch(/looks like another identity/i);

  // And Now shows no request card
  await page.goto(c.w.srv.origin + "/");
  await expect(page.getByRole("article")).toHaveCount(0);
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

  // When the owner taps "Revoke key" on the profile of "devtool" and then Confirm
  await page.goto(`${c.w.srv.origin}/crew/devtool`);
  await expect(page.getByRole("button", { name: /delete/i })).toHaveCount(0);
  await page.getByRole("button", { name: "Revoke key", exact: true }).click();
  await page.getByRole("button", { name: "Confirm revoke key" }).click();
  await expect(page.getByText("Key revoked")).toBeVisible();

  // Then no passkey prompt opens
  await expect(page.getByRole("dialog")).toHaveCount(0);

  // And Crew lists "devtool" as disabled
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
  await expect(page.getByRole("button", { name: "Revoke key", exact: true })).toHaveCount(0);
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

  // When the owner revokes the key of "devtool" with Revoke key and Confirm
  await page.goto(`${c.w.srv.origin}/crew/devtool`);
  await page.getByRole("button", { name: "Revoke key", exact: true }).click();
  await page.getByRole("button", { name: "Confirm revoke key" }).click();
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

scenario("Revoke key asks to confirm and can be cancelled", { tag: ["@browser"] }, async ({ server, page, context }) => {
  const c = await crewWorld({ server, page, context }, { agents: ["devtool"] });
  await page.goto(`${c.w.srv.origin}/crew/devtool`);

  // When the owner taps "Revoke key" on the profile of "devtool"
  await page.getByRole("button", { name: "Revoke key", exact: true }).click();

  // Then the profile asks "Revoke the key for @devtool?" with Confirm and Cancel
  const ask = page.getByRole("group", { name: "Revoke key" });
  await expect(ask).toContainText("Revoke the key for @devtool?");
  await expect(ask.getByRole("button", { name: "Confirm revoke key" })).toBeVisible();

  // When the owner taps Cancel
  await ask.getByRole("button", { name: "Cancel" }).click();

  // Then "devtool" is still enabled and "Revoke key" is offered again
  await expect(page.getByRole("button", { name: "Revoke key", exact: true })).toBeVisible();
  const list = (await c.w.owner.client.get("/api/identities")).json().identities as { handle: string; disabled: boolean }[];
  expect(list.find((i) => i.handle === "devtool")?.disabled).toBe(false);
});

scenario("The profile shows when the key was created and when it was last used", { tag: ["@browser"] }, async ({ server, dataDir, page, context }) => {
  // Given "devtool" has a session that was last seen 2 minutes ago
  const c = await crewWorld({ server, page, context }, {
    agents: ["devtool"],
    live: ["devtool"],
    plaintext: true,
    beforeSignIn: async () => void seedDb(dataDir, (db) => db.prepare("UPDATE sessions SET last_seen_at = ?").run(Date.now() - 2 * 60_000)),
  });

  // When the owner opens the profile of "devtool"
  await page.goto(`${c.w.srv.origin}/crew/devtool`);

  // Then the Details row reads "Created" with a date and "last used 2 min ago"
  await expect(page.getByRole("region", { name: "Details" })).toContainText(/Created .+ · last used 2 min ago/);
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

// ---- Rule: On a computer Crew is a page in the right pane, like a conversation --------------------------------------------------

scenario("On a computer, Crew opens as a page with one way back, and nothing hides under its search", { tag: ["@browser"] }, async ({ server, page, context }) => {
  // Given eight agents, and a window 1280 wide and 560 high, in light and in dark
  const agents = ["devtool", "docs", "scout", "ops", "build", "review", "triage", "deploy"];
  const c = await crewWorld({ server, page, context }, { agents });
  await page.setViewportSize({ width: 1280, height: 560 });

  // When the owner opens Crew and scrolls its list
  await page.goto(`${c.w.srv.origin}/crew`);
  await expect(page.locator("#crew .crow")).toHaveCount(agents.length);
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.locator("#crew .docklist").evaluate((el) => void (el.scrollTop = 90));

    // Then the bar of the page reads "Crew" and the count 8
    await expect(page.locator(".appbar #heading")).toHaveText("Crew");
    await expect(page.locator(".appbar")).toContainText(String(agents.length));

    // And the page has one back control and no element with the frame of a card
    await expect(page.locator(".appbar, #crew").getByRole("link", { name: /^(back|close)/i })).toHaveCount(1);
    const cards = await page.locator("main").evaluate((main) =>
      [main, ...main.querySelectorAll("*")].filter((el) => {
        const cs = getComputedStyle(el);
        return parseFloat(cs.borderTopWidth) > 0 && parseFloat(cs.borderTopLeftRadius) > 0 && cs.boxShadow !== "none" && el.getBoundingClientRect().height > 300;
      }).length,
    );
    expect(cards, "an element still has a card's border, radius and shadow").toBe(0);

    // And the first agent row that shows starts at or below the bottom of the search
    const geo = await page.evaluate(() => {
      const bottom = document.querySelector("#crew .fld")!.getBoundingClientRect().bottom;
      const shows = (el: Element) => {
        const r = el.getBoundingClientRect();
        return el.contains(document.elementFromPoint(r.left + r.width / 2, r.top + 2));
      };
      const first = [...document.querySelectorAll("#crew .crow")].find(shows);
      return { bottom, top: first ? first.getBoundingClientRect().top : null };
    });
    expect(geo.top, "no agent row shows").not.toBeNull();
    expect(geo.top!).toBeGreaterThanOrEqual(geo.bottom);

    // And the search and the summary above the list have an opaque background
    const alphas = await page.evaluate(() => {
      const alpha = (el: Element) => {
        const bg = getComputedStyle(el).backgroundColor;
        const m = /\/\s*([\d.]+%?)\s*\)|rgba\([^)]*,\s*([\d.]+)\)/.exec(bg);
        if (!m) return 1;
        const v = m[1] ?? m[2]!;
        return v.endsWith("%") ? parseFloat(v) / 100 : parseFloat(v);
      };
      const fld = document.querySelector("#crew .fld")!;
      return [alpha(fld), alpha(fld.parentElement!), alpha(document.querySelector("#crew .crew-top")!)];
    });
    expect(alphas).toEqual([1, 1, 1]);
  }
});

for (const [width, height] of [[390, 844], [1280, 720]] as const) {
  scenario(`Machines is in view when Crew opens, with no scrolling (${width} by ${height})`, { tag: ["@browser"] }, async ({ server, page, context }) => {
    // Given eight agents and a window <width> wide and <height> high
    const agents = ["devtool", "docs", "scout", "ops", "build", "review", "triage", "deploy"];
    const c = await crewWorld({ server, page, context }, { agents });
    await page.setViewportSize({ width, height });

    // When the owner opens Crew
    await page.goto(`${c.w.srv.origin}/crew`);
    await expect(page.locator("#crew .crow")).toHaveCount(agents.length);

    // Then the link "Machines · 1" is inside the window
    const link = page.getByRole("link", { name: "Machines · 1" });
    await expect(link).toBeVisible();
    const box = (await link.boundingBox())!;
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.y + box.height).toBeLessThanOrEqual(height);
    expect(box.x + box.width).toBeLessThanOrEqual(width);

    // And the link opens the machines page
    await link.click();
    await expect(page.getByRole("heading", { name: "Machines", exact: true })).toBeVisible();
  });
}
