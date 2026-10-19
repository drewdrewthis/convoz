import { convoz, createConversation, listConversations, messagesOf } from "../lib/chat.ts";
import { openNow } from "../lib/asks.ts";
import { revokeAgentKey } from "../lib/machines.ts";
import { asAgent, idsOf } from "../lib/wp3.ts";
import { expect, scenario } from "../lib/scenario.ts";
import { browserWorld, rowsOnList, showDetails, world, startSession } from "../lib/wp3.ts";
import { must } from "../lib/owner.ts";

// `convoz new`: an agent starts a conversation. The owner is always in it; a listed agent joins at once when it already shares a
// conversation with the creator, otherwise it is a join request (like `convoz add`).

scenario("An agent starts a conversation with the owner and another agent", { tag: ["@cli", "@browser"] }, async ({ server, page, context }) => {
  // Given "devtool" and "docs" share conversation 41
  const w = await browserWorld({ server, page, context }, { live: ["devtool"] });
  await createConversation(w.owner, { title: "Ship search filters", participants: ["devtool", "docs"] });

  // When "devtool" runs "convoz new --with @drew,@docs 'Plan: search filters' 'Here is the plan.'"
  const res = await convoz(w.box, w.sessions.devtool!.sid, ["new", "--with", "@drew,@docs", "Plan: search filters", "Here is the plan."]);

  // Then the CLI prints the new conversation id
  expect(res.code, res.stderr).toBe(0);
  expect(res.stdout).toMatch(/^\d+\n$/);
  const conv = Number(res.stdout);

  // And the Conversations list shows "Plan: search filters" with "Drew", "@devtool" and "@docs" in it
  await page.goto(`${w.srv.origin}/chats`);
  await expect(rowsOnList(page).filter({ hasText: "Plan: search filters" })).toHaveCount(1);
  await page.goto(`${w.srv.origin}/chats/${conv}`);
  const participants = (await showDetails(page)).getByRole("list", { name: "Participants" });
  for (const who of [/Drew/, /@devtool/, /@docs/]) await expect(participants.getByRole("listitem").filter({ hasText: who })).toHaveCount(1);

  // And "Here is the plan." is the first message, written by "devtool"
  expect((await messagesOf(w.owner, conv)).map((m) => [m.author.handle, m.body])).toEqual([["devtool", "Here is the plan."]]);
});

scenario("A new conversation's other agent who shares no conversation with the creator becomes a join request", { tag: ["@cli", "@browser"] }, async ({ server, page, context }) => {
  // When "devtool" runs "convoz new --json --with @release-bot 'Plan: release'"
  const w = await browserWorld({ server, page, context }, { live: ["devtool", "release-bot"] });
  const res = await convoz(w.box, w.sessions.devtool!.sid, ["new", "--json", "--with", "@release-bot", "Plan: release"]);

  // Then the CLI prints the conversation id and "release-bot" as pending
  expect(res.code, res.stderr).toBe(0);
  const out = JSON.parse(res.stdout) as { conversation_id: number; pending: string[] };
  expect(out.pending).toEqual(["release-bot"]);

  // And the owner sees one pending add for "release-bot" in Now
  await openNow(page, w.srv);
  const add = page.getByRole("article", { name: /wants to add/ });
  await expect(add).toHaveCount(1);
  await expect(add).toContainText("Devtool @devtool wants to add Release-bot @release-bot");

  // And "release-bot" cannot read the conversation until the owner approves
  const read = await convoz(w.box, w.sessions["release-bot"]!.sid, ["read", String(out.conversation_id)]);
  expect(read.code).toBe(3);
});

scenario("An agent starts at most 20 conversations an hour", { tag: ["@cli"] }, async ({ server, testApi }) => {
  // Given "devtool" started 20 conversations in the last hour
  const w = await world(server);
  const dev = await startSession(w.box, "devtool", "devtool");
  for (let i = 1; i <= 20; i++) {
    const made = await convoz(w.box, dev.sid, ["new", `Plan ${i}`]);
    expect(made.code, made.stderr).toBe(0);
  }

  // When "devtool" runs "convoz new 'One too many'"
  const over = await convoz(w.box, dev.sid, ["new", "One too many"]);

  // Then the CLI exits 5 and no conversation "One too many" exists
  expect(over.code).toBe(5);
  expect((await listConversations(w.owner)).filter((c) => c.title === "One too many")).toEqual([]);

  // When an hour has passed
  await testApi(w.srv).advanceClock(61 * 60_000);

  // Then "convoz new 'One more'" works
  const more = await convoz(w.box, dev.sid, ["new", "One more"]);
  expect(more.code, more.stderr).toBe(0);
});

// From @dot (conv 2 msg 490): "Installed CLI … and MCP expose neither conversation creation nor agent discovery."
scenario("An agent finds another agent's handle", { tag: ["@cli"] }, async ({ server }) => {
  // Given "docs" has the description "Writes the docs" and "release-bot" is disabled
  const w = await world(server);
  const ids = await idsOf(w.owner);
  const dev = await startSession(w.box, "devtool", "devtool");
  const docs = await startSession(w.box, "docs", "docs");
  must(await asAgent(w.srv, docs.lease, "PATCH", "/api/me/profile", { description: "Writes the docs" }), "docs sets its description");
  must(await revokeAgentKey(w.owner, ids["release-bot"]!), "disable release-bot");

  // When "devtool" runs "convoz agents --json"
  const res = await convoz(w.box, dev.sid, ["agents", "--json"]);
  expect(res.code, res.stderr).toBe(0);

  // Then it lists "docs" with its display name, its description and its state "idle"
  const { agents } = JSON.parse(res.stdout) as { agents: Record<string, unknown>[] };
  expect(agents).toEqual([{ handle: "docs", display_name: "Docs", description: "Writes the docs", state: "idle" }]);

  // And it lists neither "devtool", nor the disabled "release-bot", nor an id, a key or a machine
  expect(res.stdout).not.toMatch(/devtool|release-bot|machine|cvz_|"id"/);
});
