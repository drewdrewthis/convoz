import { McpClient } from "../lib/agent-wp7.ts";
import { convoz, createConversation, ownerSays } from "../lib/chat.ts";
import { crewWorld, sheetNamed } from "../lib/crew-wp9.ts";
import { send } from "../lib/http.ts";
import { must, signIn } from "../lib/owner.ts";
import { expect, scenario } from "../lib/scenario.ts";
import { asAgent, browserWorld, idsOf, linesOf, machineWith, openChat, rowsOnList, seedDb, startSession, viewOf, world, type World } from "../lib/wp3.ts";

/*
 * AGENTS RENAME CONVERSATIONS: specs/features/conversations.feature and specs/contracts/conversations.feature, Rule "An agent in a
 * conversation may rename it; a title the owner chose stays the owner's"; specs/features/cli-mcp.feature (the MCP tool) and
 * specs/features/crew.feature (the invite prompt line).
 * Owner ruling 2026-10-18, on "let agents rename conversations they're in, with a system line?": "Yes."
 * Contract: an agent with a lease and the "post" scope sends PATCH /api/conversations/:id {title}. A participant gets 200 and the
 * conversation, a non-participant 403 (an agent is never told whether a conversation exists), a title the owner chose 409 title_owner_set
 * (no timer), a title of 0 or over 120 characters 400, the fourth rename within an hour of one agent in one conversation 429.
 * The rename writes the system line '<@handle> renamed this to "<title>"'; the change event and the audit line "conversation.rename" name
 * the agent. The CLI is `convoz rename <conv> <title|->`, the MCP tool is "rename {conversation, title}".
 */

const FIRST = "Is the build green?";
const NOT_MINE = "You are not a participant of that conversation.";

/** A conversation whose title came from its first message (nobody chose it). */
async function autoTitled(w: World, participants: string[]): Promise<number> {
  const conv = await createConversation(w.owner, { participants });
  await ownerSays(w.owner, conv, FIRST);
  return conv;
}

/** `PATCH /api/conversations/:id` with a lease. */
const rename = (w: World, lease: string, conv: number, json: unknown) => asAgent(w.srv, lease, "PATCH", `/api/conversations/${conv}`, json);

/** The bodies of the rename lines of a conversation, oldest first. */
async function renameLines(w: World, conv: number): Promise<string[]> {
  return (await linesOf(w.owner, conv)).filter((l) => l.author.kind === "system" && l.body.includes("renamed")).map((l) => l.body);
}

const quoted = (title: string) => `@devtool renamed this to "${title}"`;

// ---- user-facing ---------------------------------------------------------------------------------------------------------

scenario("An agent renames a conversation it is in", { tag: ["@cli"] }, async ({ server }) => {
  // Given conversation 41 with "devtool", titled by its first message
  const w = await world(server);
  const conv = await autoTitled(w, ["devtool"]);
  expect((await viewOf(w.owner, conv)).title).toBe(FIRST);
  const dev = await startSession(w.box, "devtool", "devtool");

  // When "devtool" runs "convoz rename 41 'Build status'"
  const res = await convoz(w.box, dev.sid, ["rename", String(conv), "Build status"]);
  expect(res.code, res.stderr).toBe(0);

  // Then conversation 41 shows the system line '@devtool renamed this to "Build status"'
  expect(await renameLines(w, conv)).toEqual([quoted("Build status")]);

  // And the title of conversation 41 is "Build status"
  expect((await viewOf(w.owner, conv)).title).toBe("Build status");
});

scenario("An agent cannot rename a title the owner chose", { tag: ["@cli"] }, async ({ server }) => {
  // Given conversation 41 "Ship search filters", named by the owner, with "devtool"
  const w = await world(server);
  const conv = await createConversation(w.owner, { participants: ["devtool"], title: "Ship search filters" });
  const dev = await startSession(w.box, "devtool", "devtool");

  // When "devtool" runs "convoz rename 41 'Something else'"
  const res = await convoz(w.box, dev.sid, ["rename", String(conv), "Something else"]);

  // Then the command exits 4 and says that a person chose the title
  expect(res.code, res.stderr).toBe(4);
  expect(res.stderr).toContain("A person chose this title");

  // And the title of conversation 41 is still "Ship search filters"
  expect((await viewOf(w.owner, conv)).title).toBe("Ship search filters");

  // And conversation 41 shows no rename line
  expect(await renameLines(w, conv)).toEqual([]);
});

scenario("An agent that is not in a conversation cannot rename it", { tag: ["@cli"] }, async ({ server }) => {
  // Given conversation 41 with "devtool" only
  const w = await world(server);
  const conv = await autoTitled(w, ["devtool"]);
  const docs = await startSession(w.box, "docs", "docs");

  // When "docs" runs "convoz rename 41 'Not mine'"
  const res = await convoz(w.box, docs.sid, ["rename", String(conv), "Not mine"]);

  // Then the command exits 3
  expect(res.code, res.stderr).toBe(3);

  // And the title of conversation 41 is unchanged
  expect((await viewOf(w.owner, conv)).title).toBe(FIRST);
  expect(await renameLines(w, conv)).toEqual([]);
});

scenario("The owner sees an agent's rename in the header, the list and the chat", { tag: ["@browser"] }, async ({ server, page, context }) => {
  // Given the owner has conversation 41, titled by its first message, open with "devtool" in it
  const w = await browserWorld({ server, page, context }, { live: ["devtool"] });
  const conv = await autoTitled(w, ["devtool"]);
  await openChat(page, w.srv, conv, FIRST);

  // When "devtool" renames it to "Build status"
  const res = await rename(w, w.sessions.devtool!.lease, conv, { title: "Build status" });
  expect(res.status, res.text).toBe(200);

  // Then the header and the Conversations list show "Build status"
  await expect(page.getByRole("heading", { name: "Build status", exact: true, level: 1 })).toBeVisible();
  await page.goto(`${w.srv.origin}/chats`);
  await expect(rowsOnList(page)).toHaveText([/Build status/]);

  // And the chat shows the line '@devtool renamed this to "Build status"'
  await openChat(page, w.srv, conv, "Build status");
  await expect(page.getByRole("note").filter({ hasText: quoted("Build status") })).toBeVisible();
});

// ---- contracts -----------------------------------------------------------------------------------------------------------

scenario("A participant agent with the post scope renames a conversation", { tag: ["@api"] }, async ({ server, dataDir }) => {
  // Given conversation 41 with "devtool", titled by its first message
  const w = await world(server, { plaintext: true });
  const ids = await idsOf(w.owner);
  const conv = await autoTitled(w, ["devtool"]);
  const dev = await startSession(w.box, "devtool", "devtool");

  // When "devtool" sends PATCH /api/conversations/41 with the title "Build status"
  const res = await rename(w, dev.lease, conv, { title: "Build status" });

  // Then the server answers 200 and conversation 41 is titled "Build status"
  expect(res.status, res.text).toBe(200);
  expect(res.json().conversation.title).toBe("Build status");
  expect((await viewOf(w.owner, conv)).title).toBe("Build status");

  // And conversation 41 has the system line '@devtool renamed this to "Build status"'
  expect(await renameLines(w, conv)).toEqual([quoted("Build status")]);

  // And the change event and the audit line name "devtool" as the actor, not the owner
  const changed = seedDb(dataDir, (db) => db.prepare("SELECT actor_id FROM events WHERE type = 'conversation.changed.v1' AND conversation_id = ? ORDER BY seq").all(conv)) as { actor_id: number }[];
  expect(changed.map((e) => e.actor_id)).toEqual([ids.devtool]);
  const audit = must(await w.owner.client.get("/api/admin/audit"), "audit view").json().audit as { action: string; actor_id: number; target_id: number }[];
  expect(audit.filter((r) => r.action === "conversation.rename").map((r) => [r.actor_id, r.target_id])).toEqual([[ids.devtool, conv]]);
});

scenario("An agent without the post scope cannot rename", { tag: ["@api"] }, async ({ server }) => {
  // Given conversation 41 with "devtool", titled by its first message, and a session of "devtool" on a machine without the post scope
  const w = await world(server);
  const conv = await autoTitled(w, ["devtool"]);
  const reader = await machineWith(w.srv, w.owner, "box-3", ["devtool"], ["read"]);
  const session = await startSession(reader.box, "devtool", "reader");

  // When that session sends PATCH /api/conversations/41 with the title "Build status"
  const res = await rename(w, session.lease, conv, { title: "Build status" });

  // Then the server answers 403 and the title is unchanged
  expect(res.status, res.text).toBe(403);
  expect((await viewOf(w.owner, conv)).title).toBe(FIRST);
});

scenario("An agent outside a conversation cannot rename it or learn whether it exists", { tag: ["@api"] }, async ({ server }) => {
  // Given conversation 41 with "devtool" only
  const w = await world(server);
  const conv = await autoTitled(w, ["devtool"]);
  const docs = await startSession(w.box, "docs", "docs");

  // When "docs" sends PATCH /api/conversations/41 with the title "Not mine"
  const real = await rename(w, docs.lease, conv, { title: "Not mine" });

  // And "docs" sends PATCH /api/conversations/9999 with the title "Not there"
  const missing = await rename(w, docs.lease, 9999, { title: "Not there" });

  // Then both answers are 403 with the same body, and conversation 41 keeps its title
  expect([real.status, missing.status]).toEqual([403, 403]);
  expect(real.json()).toEqual(missing.json());
  expect(real.json().error.message).toBe(NOT_MINE);
  expect((await viewOf(w.owner, conv)).title).toBe(FIRST);
});

scenario("An agent can rename the title and nothing else", { tag: ["@api"] }, async ({ server }) => {
  // Given conversation 41 with "devtool", titled by its first message
  const w = await world(server);
  const conv = await autoTitled(w, ["devtool"]);
  const dev = await startSession(w.box, "devtool", "devtool");

  // When "devtool" sends PATCH /api/conversations/41 with only a link_url
  const link = await rename(w, dev.lease, conv, { link_url: "https://github.com/acme/convoz/pull/412" });

  // Then the server answers 403 and conversation 41 has no link
  expect(link.status, link.text).toBe(403);
  expect((await viewOf(w.owner, conv)).link_url ?? "").toBe("");

  // When "devtool" sends PATCH /api/conversations/41 with no title
  const bare = await rename(w, dev.lease, conv, {});

  // Then the server answers 400 on the field "title"
  expect(bare.status, bare.text).toBe(400);
  expect(bare.json().error.field).toBe("title");
});

scenario("A title the owner chose answers 409 title_owner_set to an agent, however old it is", { tag: ["@api"] }, async ({ server, testApi }) => {
  // Given conversation 41 "Ship search filters", named by the owner, with "devtool"
  const w = await world(server);
  const conv = await createConversation(w.owner, { participants: ["devtool"], title: "Ship search filters" });
  const dev = await startSession(w.box, "devtool", "devtool");

  // When "devtool" sends PATCH /api/conversations/41 with the title "Something else"
  const first = await rename(w, dev.lease, conv, { title: "Something else" });

  // Then the server answers 409 with the code "title_owner_set" and the title is unchanged
  expect(first.status, first.text).toBe(409);
  expect(first.json().error.code).toBe("title_owner_set");
  expect((await viewOf(w.owner, conv)).title).toBe("Ship search filters");

  // When the test clock moves 30 days
  await testApi(w.srv).advanceClock(30 * 24 * 3_600_000);
  await signIn(w.owner.client, w.owner.soft);
  const later = await startSession(w.box, "devtool", "devtool-later");

  // And "devtool" sends PATCH /api/conversations/41 with the title "Something else"
  const again = await rename(w, later.lease, conv, { title: "Something else" });

  // Then the server answers 409 with the code "title_owner_set" again
  expect(again.status, again.text).toBe(409);
  expect(again.json().error.code).toBe("title_owner_set");
  expect((await viewOf(w.owner, conv)).title).toBe("Ship search filters");
});

scenario("An agent renames an automatic or an agent-set title, and the owner's rename takes the title over", { tag: ["@api"] }, async ({ server }) => {
  // Given conversation 41 with "devtool", titled by its first message
  const w = await world(server);
  const conv = await autoTitled(w, ["devtool"]);
  const dev = await startSession(w.box, "devtool", "devtool");

  // When "devtool" renames it to "First name" and then to "Second name"
  const one = await rename(w, dev.lease, conv, { title: "First name" });
  const two = await rename(w, dev.lease, conv, { title: "Second name" });

  // Then both answers are 200 and the title is "Second name"
  expect([one.status, two.status]).toEqual([200, 200]);
  expect((await viewOf(w.owner, conv)).title).toBe("Second name");

  // When the owner renames it to "Owner name"
  must(await w.owner.client.request("PATCH", `/api/conversations/${conv}`, { csrf: true, json: { title: "Owner name" } }), "owner renames");

  // And "devtool" sends PATCH /api/conversations/41 with the title "Third name"
  const three = await rename(w, dev.lease, conv, { title: "Third name" });

  // Then the server answers 409 with the code "title_owner_set" and the title is "Owner name"
  expect(three.status, three.text).toBe(409);
  expect(three.json().error.code).toBe("title_owner_set");
  expect((await viewOf(w.owner, conv)).title).toBe("Owner name");
});

scenario("An agent's title is cleaned and bounded", { tag: ["@api"] }, async ({ server }) => {
  // Given conversation 41 with "devtool", titled by its first message
  const w = await world(server);
  const conv = await autoTitled(w, ["devtool"]);
  const dev = await startSession(w.box, "devtool", "devtool");

  // When "devtool" renames it to a title that holds a line break, a bell, a right-to-left override and an isolate
  const dirty = await rename(w, dev.lease, conv, { title: "Bu\nild\u0007 ‮status⁦" });
  expect(dirty.status, dirty.text).toBe(200);

  // Then the stored title and the quoted title have all four removed
  expect((await viewOf(w.owner, conv)).title).toBe("Build status");
  expect(await renameLines(w, conv)).toEqual([quoted("Build status")]);

  // When "devtool" sends a title of 121 characters
  const long = await rename(w, dev.lease, conv, { title: "a".repeat(121) });

  // Then the server answers 400 on the field "title"
  expect(long.status, long.text).toBe(400);
  expect(long.json().error.field).toBe("title");

  // When "devtool" sends a title that is only control and direction characters
  const empty = await rename(w, dev.lease, conv, { title: "\n‮⁦\u0007" });

  // Then the server answers 400 on the field "title"
  expect(empty.status, empty.text).toBe(400);
  expect(empty.json().error.field).toBe("title");

  // When "devtool" sends a title of 120 characters
  const edge = await rename(w, dev.lease, conv, { title: "b".repeat(120) });

  // Then the server answers 200
  expect(edge.status, edge.text).toBe(200);

  // And conversation 41 has exactly two rename lines, one for each answer of 200
  expect(await renameLines(w, conv)).toEqual([quoted("Build status"), quoted("b".repeat(120))]);
});

scenario("An agent may rename a conversation 3 times an hour", { tag: ["@api"] }, async ({ server, testApi }) => {
  // Given conversations 41 and 42 with "devtool", titled by their first messages
  const w = await world(server);
  const first = await autoTitled(w, ["devtool"]);
  const second = await autoTitled(w, ["devtool"]);
  const dev = await startSession(w.box, "devtool", "devtool");

  // When "devtool" renames conversation 41 to "One", "Two" and "Three"
  for (const title of ["One", "Two", "Three"]) expect((await rename(w, dev.lease, first, { title })).status, title).toBe(200);

  // And "devtool" sends PATCH /api/conversations/41 with the title "Four"
  const over = await rename(w, dev.lease, first, { title: "Four" });

  // Then the server answers 429 with a Retry-After and the title is "Three"
  expect(over.status, over.text).toBe(429);
  expect(Number(over.headers["retry-after"])).toBeGreaterThan(0);
  expect((await viewOf(w.owner, first)).title).toBe("Three");

  // And "devtool" can still rename conversation 42
  expect((await rename(w, dev.lease, second, { title: "Elsewhere" })).status).toBe(200);

  // When the test clock moves 61 minutes
  await testApi(w.srv).advanceClock(61 * 60_000);

  // Then "devtool" can rename conversation 41 to "Four"
  const later = await rename(w, dev.lease, first, { title: "Four" });
  expect(later.status, later.text).toBe(200);
  expect((await viewOf(w.owner, first)).title).toBe("Four");
});

scenario("An empty conversation an agent renamed is still cleaned up after 24 hours", { tag: ["@api", "@I-20"] }, async ({ server, testApi }) => {
  // Given an empty conversation 41 with "devtool" and an empty conversation 42 the owner renamed
  const w = await world(server);
  const agentRenamed = await createConversation(w.owner, { participants: ["devtool"] });
  const ownerRenamed = await createConversation(w.owner, { participants: ["devtool"] });
  must(await w.owner.client.request("PATCH", `/api/conversations/${ownerRenamed}`, { csrf: true, json: { title: "Kept by its name" } }), "owner renames");
  const dev = await startSession(w.box, "devtool", "devtool");

  // When "devtool" renames conversation 41 to "Build status"
  expect((await rename(w, dev.lease, agentRenamed, { title: "Build status" })).status).toBe(200);

  // And the test clock moves 24 hours and 1 minute and the cleanup runs
  await testApi(w.srv).advanceClock((24 * 60 + 1) * 60_000);
  await signIn(w.owner.client, w.owner.soft);
  must(await send(w.srv.target, "POST", "/__test/maintenance", { json: {} }), "cleanup");

  // Then conversation 41 is gone and conversation 42 exists
  expect((await w.owner.client.get(`/api/conversations/${agentRenamed}`)).status).toBe(404);
  expect((await viewOf(w.owner, ownerRenamed)).title).toBe("Kept by its name");
});

// ---- the MCP tool and the invite prompt ----------------------------------------------------------------------------------

scenario("An agent renames a conversation through MCP", { tag: ["@mcp"] }, async ({ server }) => {
  // Given conversation 41 is titled by its first message
  const w = await world(server);
  const conv = await autoTitled(w, ["devtool"]);
  const mcp = await McpClient.start(w.box, "devtool", "claude-TESTONLY-rename");
  try {
    // When "devtool" calls the tool "rename" with conversation 41 and the title "Build status"
    const result = await mcp.tool("rename", { conversation: conv, title: "Build status" });

    // Then the tool result gives the title "Build status"
    expect(result.isError, result.content[0]?.text).not.toBe(true);
    expect(result.structuredContent).toMatchObject({ conversation_id: conv, title: "Build status" });

    // And conversation 41 shows the system line '@devtool renamed this to "Build status"'
    expect(await renameLines(w, conv)).toEqual([quoted("Build status")]);
  } finally {
    mcp.end();
    await mcp.exited;
  }
});

scenario("The invite prompt tells an agent it may rename a conversation", { tag: ["@browser"] }, async ({ server, page, context }) => {
  // Background
  const c = await crewWorld({ server, page, context }, { agents: ["devtool"] });
  await page.goto(`${c.w.srv.origin}/crew`);

  // When the owner opens Crew and taps "Invite agent"
  await page.getByRole("button", { name: /^(Add|Invite) agent$/ }).first().click();
  const prompt = sheetNamed(page, "Invite agent").getByLabel("Connect prompt");

  // Then the prompt has a rename line with "convoz rename <conversation>"
  await expect(prompt).toContainText("Rename:");
  await expect(prompt).toContainText("convoz rename <conversation>");

  // And the rename line says that a title the owner chose stays the owner's
  await expect(prompt).toContainText("a title the owner chose stays theirs");
});
