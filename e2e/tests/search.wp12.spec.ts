import type { BrowserContext, Page } from "@playwright/test";
import { agentPostWith, ownerDeletes, ownerPurges, pageOf } from "../lib/messages-wp4.ts";
import { convoz, ownerSays, startSession } from "../lib/chat.ts";
import { signInBrowser } from "../lib/machines.ts";
import { must } from "../lib/owner.ts";
import { expect, scenario } from "../lib/scenario.ts";
import { searchAs, searchWorld, wordsOf, type Found, type SearchWorld } from "../lib/search-wp12.ts";

/*
 * SEARCH (WP12): specs/features/search.feature. The contract the bindings assert is the block atop lib/search-wp12.ts
 * (GET /api/search, the CLI `convoz search`) and the search overlay of the shell:
 *
 * THE OVERLAY  A button "Search" in the top bar of every signed-in page (and Ctrl/Cmd+K) opens a dialog "Search": a combobox "Search",
 *   the "Active filters" group of chips (each a button "Remove filter: <label>" that takes its filter out of the text), a listbox
 *   "Search results" with the groups "Conversations", "Messages" and "Asks" (each row an option; the words the query matched are in
 *   <mark>), and a status line ("3 results · 4 ms"). An option opens its conversation at /chats/<id>#m<message id>: the page loads the
 *   message if it is older than the first page, scrolls it to the middle and marks its article data-hl="true" for a moment.
 */

/** Given the fixture, with the owner's browser signed in (any API step-up comes before this). */
async function browserSearchWorld(fx: { server: Parameters<typeof searchWorld>[0]["server"]; dataDir: string; page: Page; context: BrowserContext }): Promise<SearchWorld> {
  const w = await searchWorld(fx);
  await signInBrowser(w.srv, w.owner, fx.page, fx.context);
  return w;
}

const searchDialog = (page: Page) => page.getByRole("dialog", { name: "Search" });
const searchBox = (page: Page) => searchDialog(page).getByRole("combobox", { name: "Search" });
const messageOptions = (page: Page) => searchDialog(page).getByRole("group", { name: "Messages" }).getByRole("option");

/** Open the search overlay from the Conversations page and type the text. */
async function typeSearch(page: Page, text: string, how: "button" | "keys" = "button"): Promise<void> {
  // A conversation has no top bar with the button: there the shortcut opens it.
  if (how === "keys") await page.keyboard.press("Control+K");
  else await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(searchDialog(page)).toBeVisible();
  await searchBox(page).fill(text);
}

scenario("A new message is searchable at once", { tag: ["@browser"] }, async ({ server, dataDir, page, context }) => {
  // Background
  const w = await browserSearchWorld({ server, dataDir, page, context });
  await page.goto(`${w.srv.origin}/chats`);
  await expect(page.getByRole("heading", { name: "Conversations", exact: true })).toBeVisible();

  // When "devtool" posts "retry budget is 3 attempts" in conversation 41
  must(await agentPostWith(w.srv, w.devtool, w.conv, { body: "retry budget is 3 attempts" }), "post", 201);

  // And the owner searches "budget" right away
  await typeSearch(page, "budget");

  // Then the first result is that message with "budget" highlighted
  const first = messageOptions(page).first();
  await expect(first).toContainText("retry budget is 3 attempts");
  await expect(first.locator("mark")).toHaveText("budget");
  await expect(searchDialog(page).getByRole("status")).toContainText(/\d+ results?/);
});

scenario("Results are newest first", { tag: ["@api"] }, async ({ server, dataDir, testApi }) => {
  // Background
  const w = await searchWorld({ server, dataDir });

  // Given 5 messages that contain "rollback" posted on 5 different days
  const posted: number[] = [];
  for (let day = 1; day <= 5; day++) {
    await testApi(w.srv).advanceClock(24 * 3_600_000);
    posted.push(await ownerSays(w.owner, w.conv, `rollback drill of day ${day}`));
  }

  // When the owner searches "rollback"
  const { results } = await searchAs(w, "rollback");

  // Then the results are ordered from newest to oldest
  const days = results.filter((r) => posted.includes(r.message_id));
  expect(days.map((r) => r.message_id)).toEqual([...posted].reverse());
  expect(results.map((r) => r.created_at)).toEqual([...results.map((r) => r.created_at)].sort((a, b) => b - a));
  expect(new Set(days.map((r) => new Date(r.created_at).toDateString())).size).toBe(5);
});

scenario("A two-letter prefix works", { tag: ["@api"] }, async ({ server, dataDir }) => {
  // Background
  const w = await searchWorld({ server, dataDir });

  // When the owner searches "ro"
  const { results } = await searchAs(w, "ro");

  // Then results include messages with "rollback" and "router"
  expect(results.some((r) => /rollback/.test(wordsOf(r)))).toBe(true);
  expect(results.some((r) => /router/.test(wordsOf(r)))).toBe(true);
  for (const r of results) expect(r.snippet.some((p) => p.hit && /^ro/i.test(p.text)), `"${wordsOf(r)}" holds a word that starts with ro`).toBe(true);
});

scenario("A result opens in its conversation", { tag: ["@browser"] }, async ({ server, dataDir, page, context }) => {
  // Background
  const w = await browserSearchWorld({ server, dataDir, page, context });
  await page.goto(`${w.srv.origin}/chats`);
  await expect(page.getByRole("heading", { name: "Conversations", exact: true })).toBeVisible();
  // Enough later messages that the one searched for is older than the first page of its conversation
  for (let i = 0; i < 120; i++) await ownerSays(w.owner, w.conv52, `later note ${i}`);
  const wanted = (await searchAs(w, "runbook")).results[0]!;
  expect(wanted.conversation_id).toBe(w.conv52);
  const held = await pageOf(w.owner, w.conv52, "limit=100");
  expect(held.some((m) => m.id === wanted.message_id), "the message is not on the first page").toBe(false);

  // When the owner searches "runbook" and opens the first result
  // (the first result of the group "Messages": the group "Conversations" above it holds the conversation whose title says "runbook")
  await typeSearch(page, "runbook");
  await expect(messageOptions(page).first()).toContainText(wordsOf(wanted).replace(/…/g, "").trim().slice(0, 20));
  await messageOptions(page).first().click();

  // Then conversation 52 opens scrolled to that message with it highlighted
  await expect(page).toHaveURL(new RegExp(`/chats/${w.conv52}#m${wanted.message_id}$`));
  const shown = page.getByRole("log", { name: "Messages" }).getByRole("article").filter({ hasText: "the alert filters for the runbook" });
  await expect(shown).toBeVisible();
  await expect(shown).toHaveAttribute("data-hl", "true");
  await expect(shown).toBeInViewport({ ratio: 1 });
  await expect(page.getByRole("log", { name: "Messages" }).getByRole("article").filter({ hasText: "later note 119" })).not.toBeInViewport();
});

scenario("Choosing a thread result opens that thread", { tag: ["@browser"] }, async ({ server, dataDir, page, context }) => {
  // Background
  const w = await browserSearchWorld({ server, dataDir, page, context });

  // Given "devtool" replied "spikereply is the answer" in a thread of conversation 41
  const root = must(await agentPostWith(w.srv, w.devtool, w.conv, { body: "which step ships first" }), "root", 201).json().id as number;
  must(await agentPostWith(w.srv, w.devtool, w.conv, { body: "spikereply is the answer", thread_root_id: root }), "reply", 201);
  const thread = page.getByRole("dialog", { name: /^Thread / }).or(page.getByRole("complementary", { name: /^Thread / }));
  const opened = async () => {
    await expect(searchDialog(page)).toBeHidden();
    await expect(thread.getByRole("log", { name: "Thread messages" }).getByRole("article").filter({ hasText: "spikereply is the answer" })).toBeVisible();
  };

  // When the owner searches "spikereply" and chooses the thread result
  await page.goto(`${w.srv.origin}/chats`);
  await expect(page.getByRole("heading", { name: "Conversations", exact: true })).toBeVisible();
  await typeSearch(page, "spikereply");
  await messageOptions(page).first().click();

  // Then the thread opens with that reply and Find anything is closed
  await opened();

  // When the owner searches "spikereply" again and presses Enter on the thread result
  await page.goto(`${w.srv.origin}/chats`);
  await expect(page.getByRole("heading", { name: "Conversations", exact: true })).toBeVisible();
  await typeSearch(page, "spikereply");
  await expect(messageOptions(page).first()).toContainText("spikereply");
  await searchBox(page).press("Enter");

  // Then the thread opens with that reply and Find anything is closed
  await opened();
});

scenario("Choosing a result for the conversation you are already in closes Find anything", { tag: ["@browser"] }, async ({ server, dataDir, page, context }) => {
  // Background
  const w = await browserSearchWorld({ server, dataDir, page, context });

  // Given the owner is in conversation 41
  await page.goto(`${w.srv.origin}/chats/${w.conv}`);
  const log = page.getByRole("log", { name: "Messages" });
  await expect(log.getByRole("article").filter({ hasText: "rollback if the filters slow the page" })).toBeVisible();

  // When the owner searches "Ship search filters" and chooses the conversation result
  await typeSearch(page, "Ship search filters", "keys");
  await searchDialog(page).getByRole("group", { name: "Conversations" }).getByRole("option").first().click();

  // Then Find anything is closed and conversation 41 is still open
  await expect(searchDialog(page)).toBeHidden();
  await expect(page).toHaveURL(new RegExp(`/chats/${w.conv}$`));
  await expect(log).toBeVisible();

  // When the owner searches "rollback" and chooses the message result
  await typeSearch(page, "rollback", "keys");
  await messageOptions(page).filter({ hasText: "rollback if the filters slow the page" }).first().click();

  // Then Find anything is closed and that message is highlighted
  await expect(searchDialog(page)).toBeHidden();
  await expect(log.getByRole("article").filter({ hasText: "rollback if the filters slow the page" })).toHaveAttribute("data-hl", "true");
});

scenario("Typing @ lists the agents and starts a conversation with one", { tag: ["@browser"] }, async ({ server, dataDir, page, context }) => {
  // Background
  const w = await browserSearchWorld({ server, dataDir, page, context });
  await page.goto(`${w.srv.origin}/chats`);
  await expect(page.getByRole("heading", { name: "Conversations", exact: true })).toBeVisible();

  // When the owner types "@" in Find anything
  await typeSearch(page, "@");

  // Then the agents "devtool" and "docs" are listed
  const agents = searchDialog(page).getByRole("group", { name: "Start a conversation with" }).getByRole("option");
  await expect(agents.filter({ hasText: "devtool" })).toBeVisible();
  await expect(agents.filter({ hasText: "docs" })).toBeVisible();
  await expect(searchDialog(page).getByRole("group", { name: "Messages" })).toHaveCount(0);

  // When the owner types "@doc" and presses Enter
  await searchBox(page).fill("@doc");
  await expect(agents).toHaveCount(1);
  await expect(agents.first()).toContainText("docs");
  await searchBox(page).press("Enter");

  // Then a new conversation with "docs" opens with the cursor in the composer and Find anything is closed
  await expect(page).toHaveURL(/\/chats\/new\?with=docs$/);
  await expect(searchDialog(page)).toHaveCount(0);
  await expect(page.locator("textarea:focus")).toBeVisible();
  await expect(page.getByText("@docs").first()).toBeVisible();
});

scenario("Each filter narrows the results", { tag: ["@api"] }, async ({ server, dataDir }) => {
  // Background
  const w = await searchWorld({ server, dataDir });
  const db = w.db();
  const total = (db.prepare("SELECT COUNT(*) AS n FROM messages WHERE kind <> 'system'").get() as { n: number }).n;
  const column = (sql: string) => new Set((db.prepare(sql).all() as { id: number }[]).map((r) => Number(r.id)));
  const pinned = column("SELECT message_id AS id FROM pins");
  const starred = column("SELECT conversation_id AS id FROM conversation_prefs WHERE starred_at IS NOT NULL");
  const files = column("SELECT message_id AS id FROM uploads WHERE message_id IS NOT NULL");
  db.close();
  const bodyOf = new Map<number, string>();
  for (const conv of [w.conv, w.conv52]) for (const m of await pageOf(w.owner, conv, "limit=100")) bodyOf.set(m.id, m.body);

  const rows: { query: string; matches: string; ok: (r: Found) => boolean }[] = [
    { query: "from:@devtool deploy", matches: 'was written by "devtool"', ok: (r) => r.author.handle === "devtool" },
    { query: 'in:"Deploy alerts" error', matches: "is in conversation 52", ok: (r) => r.conversation_id === w.conv52 },
    { query: "is:ask", matches: "is an ask", ok: (r) => r.kind === "ask" },
    { query: "is:pinned", matches: "is a message the owner pinned", ok: (r) => pinned.has(r.message_id) },
    { query: "is:starred", matches: "is in a conversation the owner starred", ok: (r) => starred.has(r.conversation_id) },
    { query: "is:app", matches: "is an app message", ok: (r) => r.app === true },
    { query: "has:file", matches: "has an attachment", ok: (r) => files.has(r.message_id) },
    { query: "has:link", matches: "has a link", ok: (r) => /https?:\/\//.test(bodyOf.get(r.message_id) ?? "") },
  ];
  for (const row of rows) {
    // When the owner searches <query>
    const { results } = await searchAs(w, row.query);

    // Then every result <matches>
    expect(results.length, `${row.query} finds something`).toBeGreaterThan(0);
    expect(results.length, `${row.query} leaves some messages out`).toBeLessThan(total);
    for (const r of results) expect(row.ok(r), `${row.query}: #${r.message_id} "${wordsOf(r)}" ${row.matches}`).toBe(true);
  }
  // The words still count beside a filter, and a filter alone needs none.
  expect((await searchAs(w, "from:@devtool deploy")).results.map(wordsOf).join("|")).toContain("deploy");
});

scenario("Filter chips show and can be removed", { tag: ["@browser"] }, async ({ server, dataDir, page, context }) => {
  // Background
  const w = await browserSearchWorld({ server, dataDir, page, context });
  await page.goto(`${w.srv.origin}/chats`);
  await expect(page.getByRole("heading", { name: "Conversations", exact: true })).toBeVisible();

  // When the owner searches "from:@devtool has:file chart"
  await typeSearch(page, "from:@devtool has:file chart");

  // Then "Active filters" shows "from @devtool" and "has file"
  const chips = searchDialog(page).getByRole("group", { name: "Active filters" });
  await expect(chips.getByRole("button", { name: "Remove filter: from @devtool" })).toContainText("from @devtool");
  await expect(chips.getByRole("button", { name: "Remove filter: has file" })).toContainText("has file");
  await expect(messageOptions(page)).toHaveCount(1);

  // And removing "has file" widens the results
  await chips.getByRole("button", { name: "Remove filter: has file" }).click();
  await expect(chips.getByRole("button", { name: "Remove filter: has file" })).toHaveCount(0);
  await expect(chips.getByRole("button", { name: "Remove filter: from @devtool" })).toBeVisible();
  await expect(messageOptions(page)).toHaveCount(2);
  await expect(searchBox(page)).toHaveValue("from:@devtool chart ");
});

scenario("Deleted and purged messages are not found", { tag: ["@api"] }, async ({ server, dataDir }) => {
  // Background
  const w = await searchWorld({ server, dataDir });

  // Given the owner deleted a message with "ZQX-deleted" and purged one with "ZQX-purged"
  const deleted = await ownerSays(w.owner, w.conv, "ZQX-deleted note");
  const purged = await ownerSays(w.owner, w.conv, "ZQX-purged note");
  expect((await searchAs(w, "ZQX")).results.map((r) => r.message_id).sort()).toEqual([deleted, purged].sort()); // both are found until then
  expect((await ownerDeletes(w.owner, deleted)).status).toBe(200);
  expect((await ownerPurges(w.owner, purged)).status).toBe(200);

  // When the owner searches "ZQX"
  const answer = await searchAs(w, "ZQX");

  // Then no result is returned
  expect(answer.results).toEqual([]);
  expect(answer.conversations).toEqual([]);
  const db = w.db();
  for (const [table, key] of [["search_entries", "message_id"], ["messages_fts_docsize", "id"]] as const) {
    const n = (db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${key} IN (?, ?)`).get(deleted, purged) as { n: number }).n;
    expect(n, `${table} holds no row of the deleted or the purged message`).toBe(0);
  }
  db.close();
  expect((await searchAs(w, "chips")).results.length, "search still finds the others").toBeGreaterThan(0);
});

scenario("A conversation in the trash is not found", { tag: ["@api"] }, async ({ server, dataDir }) => {
  // Background
  const w = await searchWorld({ server, dataDir });
  expect((await searchAs(w, "runbook")).results.some((r) => r.conversation_id === w.conv52)).toBe(true); // found until it is deleted

  // Given the owner deleted conversation 52
  must(await w.owner.client.del(`/api/conversations/${w.conv52}`), "delete conversation 52");

  // When the owner searches "runbook"
  const answer = await searchAs(w, "runbook");

  // Then no result is from conversation 52
  expect(answer.results.filter((r) => r.conversation_id === w.conv52)).toEqual([]);
  expect(answer.conversations.filter((c) => c.id === w.conv52)).toEqual([]);
  expect((await searchAs(w, "is:ask")).results.map((r) => r.conversation_id), "the trash holds the ask of 52, and only that").toEqual([w.conv]);
  expect((await searchAs(w, "chips")).results.length, "conversation 41 is still searched").toBeGreaterThan(0);
});

scenario("An agent finds only conversations it is in", { tag: ["@cli"] }, async ({ server, dataDir }) => {
  // Background
  const w = await searchWorld({ server, dataDir });

  // Given "docs" is in conversation 52 only
  const members = async (conv: number) =>
    (must(await w.owner.client.get(`/api/conversations/${conv}`), "read").json().conversation.participants as { handle: string }[]).map((p) => p.handle);
  expect(await members(w.conv52)).toContain("docs");
  expect(await members(w.conv)).not.toContain("docs");

  // When "docs" runs "convoz search filters"
  const docs = await startSession(w.box, "docs", "search");
  const res = await convoz(w.box, docs.sid, ["search", "--json", "filters"]);
  expect(res.code, res.stderr).toBe(0);
  const found = JSON.parse(res.stdout).results as Found[];

  // Then no result is from conversation 41
  expect(found.length).toBeGreaterThan(0);
  expect(found.filter((r) => r.conversation_id === w.conv)).toEqual([]);
  expect(found.every((r) => r.conversation_id === w.conv52)).toBe(true);
  const text = await convoz(w.box, docs.sid, ["search", "filters"]);
  expect(text.stdout).toContain("@docs in Deploy alerts runbook");
  expect(text.stdout).not.toContain("Ship search filters");
  // naming the conversation does not get an agent in, and "devtool", who is in both, finds both
  const named = JSON.parse((await convoz(w.box, docs.sid, ["search", "--json", "--in", String(w.conv), "filters"])).stdout).results as Found[];
  expect(named).toEqual([]);
  const dev = await startSession(w.box, "devtool", "search");
  const both = JSON.parse((await convoz(w.box, dev.sid, ["search", "--json", "filters"])).stdout).results as Found[];
  expect(new Set(both.map((r) => r.conversation_id))).toEqual(new Set([w.conv, w.conv52]));
});
