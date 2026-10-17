import type { BrowserContext, Page } from "@playwright/test";
import { createRenderer, mentionsOf, project, type MdChild, type MdNode } from "../../packages/markdown/src/index.ts";
import { agentPost, convoz, createConversation, ownerPost, ownerSays, startSession } from "../lib/chat.ts";
import { send } from "../lib/http.ts";
import { messageLog } from "../lib/chat-ui.ts";
import { allow, bearer, createAgent, loginMachine, mintSession, signInBrowser } from "../lib/machines.ts";
import { fuzzBodies, mentionFixtures, projectionFixtures } from "../lib/messages-fixtures.ts";
import {
  agentDeletes,
  agentEdits,
  agentPostWith,
  agentsPost,
  byBody,
  eventTypesAfter,
  idsByHandle,
  leaseOf,
  maxEventSeq,
  msgWorld,
  ownerDeletes,
  ownerEdits,
  ownerPostWith,
  ownerPurges,
  ownerResumes,
  pageOf,
  rowsWith,
  spendMachineBudget,
  systemLine,
  type MsgWorld,
} from "../lib/messages-wp4.ts";
import { searchAs } from "../lib/search-wp12.ts";
import { must } from "../lib/owner.ts";
import { expect, scenario } from "../lib/scenario.ts";

/*
 * MESSAGES AND THEIR TYPES (WP4): the contract the bindings in this file assert. Read with specs/features/messages-types.feature,
 * specs/contracts/messages-types.feature and docs/messages-apps-spec.md. The chat contract atop tests/chat-api.spec.ts still holds;
 * this block adds to it.
 *
 * A MESSAGE as the owner and agents read it (GET /api/conversations/:id/messages, the stream's message.created frame):
 *   {id, author:{handle,display_name,kind}, body, format, created_at, kind?:"system"|"ask" (absent = text), thread_root_id?, broadcast?,
 *    reply_count?, edited_at?, deleted?:true (a tombstone: body is ""), purged?:true, system?:{t, identity?, by?, via?, ...}, text?,
 *    session_label?, machine?}
 *   A message an agent wrote carries `session_label` and `machine` (I-40). A system line has kind "system", an empty author, `system`
 *   (the subtype and the people it names, looked up when read so a rename shows at once) and `text` (its words). Main-list pages hold
 *   system lines and tombstones in their place; a reply is not in the main list unless it is a broadcast.
 *
 * ROUTES
 *   POST /api/conversations/:id/messages  {client_id, body, format?, thread_root_id?, broadcast?, upload_ids?, app?(agent only)}
 *        400 field "body" (over 16384 bytes, or more than 5 links), "app" (over 65536 bytes), "upload_ids" (over 10), "thread_root_id"
 *        (not a top-level message of that conversation; code system_line_no_replies for a system line).
 *        429 code conversation_paused (no Retry-After) while the loop breaker holds the conversation; 429 rate_limited with Retry-After
 *        for the budgets (1/s burst 20, 5000/day per identity, 20000/day per machine).
 *   PATCH /api/messages/:id  {client_id, body, format?}  author only. 200 {message}. 400 for any other field or for an ask, an answer, a
 *        message sent through an app and a system line (code not_editable); 403 for another author, and for an agent after 24 hours; 429
 *        for an agent's 31st edit within an hour. An edit changes no mention, adds nobody, makes no inbox item (its only event is
 *        message.edited.v1). The old text goes to the history: GET /api/messages/:id/edits -> {edits:[{body,format,edited_at,by}]}.
 *   DELETE /api/messages/:id  author, or the owner for any. 200 {message} (a tombstone). 403 for an agent deleting another's.
 *   POST /api/messages/:id/purge  owner with a step-up for action "message.purge" on the message. Scrubs body, app, app result, history
 *        and mentions, the results sent through it, and tells every module that holds a copy.
 *   POST /api/conversations/:id/resume  a person; lifts the loop breaker and writes a "resumed" line. 200 {resumed:boolean}.
 *
 * LOOP BREAKER (I-16): an agent message, reply or ask counts one; the 20th pauses the conversation (a conversation.paused line, the
 *   event conversation.paused.v1); a person's message (not one sent through an app) or Resume sets the count to 0.
 *
 * TEST BUILD  POST /__test/system-line {conversation, t, identity?, by?, via?, history?, reason?, streak?} (handles, not ids),
 *   POST /__test/post-many {conversation, author, messages:[{body,format}]} -> {ids} (message.Post, one transaction),
 *   POST /__test/message-budget {machine, count}, POST /__test/project {message} -> {short,long}. CONVOZ_TEST_PLAINTEXT=1 opens the data file.
 *
 * Where a scenario starts from an action of another work package (adding a participant, a rename, an ask, an upload, an app result,
 * a search), the Given is made with the nearest thing this build has (the system-line hook, a row written to the data file) and the
 * Then asserts what this module owns; each such place says so.
 */

// ---- small helpers ------------------------------------------------------------------------------------------

/** Every element of a render tree. */
function elements(node: MdChild): MdNode[] {
  return typeof node === "string" ? [] : [node, ...node.kids.flatMap(elements)];
}

/** The text of a render tree. */
function textOf(node: MdChild): string {
  return typeof node === "string" ? node : node.kids.map(textOf).join("");
}

const errorOf = (res: { json: () => any }) => res.json().error as { code: string; field?: string; message: string };

/** The handles of a conversation's participants as the owner reads them. */
async function participantsOf(w: MsgWorld, conv = w.conv): Promise<string[]> {
  const c = must(await w.owner.client.get(`/api/conversations/${conv}`), "read conversation").json().conversation;
  return c.participants.map((p: { handle: string }) => p.handle);
}

/** The inbox items an agent holds for a conversation (a peek: nothing is claimed). */
async function itemsFor(w: MsgWorld, lease: string, conv = w.conv): Promise<unknown[]> {
  const res = must(await send(w.srv.target, "GET", "/api/inbox?peek=1", bearer(lease)), "peek the inbox");
  return (res.json().items as { conversation: { id: number } }[]).filter((i) => i.conversation.id === conv);
}

const LOOP = 20;

/** Given a conversation paused after 20 agent messages (devtool and docs take turns). Returns their leases. */
async function paused(w: MsgWorld): Promise<{ dev: string; docs: string }> {
  const dev = await leaseOf(w, "devtool");
  const docs = await leaseOf(w, "docs");
  await agentsPost(w, [dev, docs], w.conv, LOOP);
  return { dev, docs };
}

/** A JSON app of exactly `bytes` bytes. Its text pads it; the app validator of the apps work package decides later what a real one holds. */
function appOf(bytes: number): Record<string, unknown> {
  const app = (text: string) => ({ v: 1, type: "code", title: "Padding", fallback: "Padding", props: { mode: "code", text } });
  const pad = bytes - Buffer.byteLength(JSON.stringify(app("")));
  const made = app("a".repeat(pad));
  expect(Buffer.byteLength(JSON.stringify(made))).toBe(bytes);
  return made;
}

// ---- formats and system lines -------------------------------------------------------------------------------

scenario("Each format renders for the owner", { tag: ["@cli"] }, async ({ server, dataDir }) => {
  // Background
  const w = await msgWorld({ server, dataDir });
  const dev = await startSession(w.box, "devtool", "formats");
  const render = createRenderer(null); // the web app's own renderer, run in Node

  const rows = [
    { format: "markdown", body: "**Build** is green", shown: (t: MdNode) => elements(t).some((e) => e.tag === "strong" && textOf(e) === "Build") },
    {
      format: "markdownv2",
      body: "Picked up *bug 8642*\\. Reproducing",
      shown: (t: MdNode) => elements(t).some((e) => e.tag === "strong" && textOf(e) === "bug 8642") && textOf(t) === "Picked up bug 8642. Reproducing",
    },
    { format: "plain", body: "**not bold**", shown: (t: MdNode) => elements(t).every((e) => e.tag !== "strong") && textOf(t) === "**not bold**" },
  ];
  for (const row of rows) {
    // When "devtool" runs "convoz post 41 --format <format>" with the body <body>
    const res = await convoz(w.box, dev.sid, ["post", "--format", row.format, String(w.conv), row.body]);
    expect(res.code, res.stderr).toBe(0);

    // Then the owner sees <shown> in conversation 41
    const stored = await byBody(w.owner, w.conv, row.body);
    expect(stored.format).toBe(row.format);
    expect(row.shown(render(stored.body, { format: stored.format as "markdown" })), `${row.format} renders as asked`).toBe(true);
  }
});

scenario("Every agent message shows its session and machine", { tag: ["@api"] }, async ({ server, dataDir }) => {
  // Background
  const w = await msgWorld({ server, dataDir });

  // When "devtool" posts "Build is green" from session label "claude-7f3a" on "box-2"
  const lease = await leaseOf(w, "devtool", "claude-7f3a");
  must(await agentPost(w.srv, lease, w.conv, "Build is green"), "post", 201);

  // Then the owner opens the message details and sees session "claude-7f3a" and machine "box-2"
  const shown = await byBody(w.owner, w.conv, "Build is green");
  expect(shown.session_label).toBe("claude-7f3a");
  expect(shown.machine).toBe("box-2");
});

// ---- edits and deletes --------------------------------------------------------------------------------------

scenario("An agent edits its own text within 24 hours", { tag: ["@api"] }, async ({ server, dataDir, testApi }) => {
  // Given "devtool" posted "Build is gren" 2 hours ago
  const w = await msgWorld({ server, dataDir });
  const lease = await leaseOf(w, "devtool");
  const id = must(await agentPost(w.srv, lease, w.conv, "Build is gren"), "post", 201).json().id as number;
  await testApi(w.srv).advanceClock(2 * 3_600_000);

  // When it edits the message to "Build is green"
  const edit = await agentEdits(w.srv, lease, id, { body: "Build is green" });
  expect(edit.status, edit.text).toBe(200);

  // Then the owner sees "Build is green" marked edited
  const shown = (await pageOf(w.owner, w.conv)).find((m) => m.id === id)!;
  expect(shown.body).toBe("Build is green");
  expect(shown.edited_at).toBeGreaterThan(0);
});

scenario("An agent cannot edit after 24 hours", { tag: ["@api"] }, async ({ server, dataDir, testApi }) => {
  // Given "devtool" posted a message 25 hours ago
  const w = await msgWorld({ server, dataDir });
  const old = await leaseOf(w, "devtool");
  const id = must(await agentPost(w.srv, old, w.conv, "Old text"), "post", 201).json().id as number;
  await testApi(w.srv).advanceClock(25 * 3_600_000);
  const lease = await leaseOf(w, "devtool"); // the first lease ran out after 12 hours

  // When it edits the message
  const edit = await agentEdits(w.srv, lease, id, { body: "New text" });

  // Then the server answers 403
  expect(edit.status).toBe(403);
  expect((await byBody(w.owner, w.conv, "Old text")).edited_at).toBeUndefined();
});

scenario("Agent edits are limited to 30 per hour", { tag: ["@api"] }, async ({ server, dataDir }) => {
  // Given "devtool" made 30 edits in the last hour
  const w = await msgWorld({ server, dataDir });
  const lease = await leaseOf(w, "devtool");
  const id = must(await agentPost(w.srv, lease, w.conv, "v0"), "post", 201).json().id as number;
  for (let n = 1; n <= 30; n++) must(await agentEdits(w.srv, lease, id, { body: `v${n}` }), `edit ${n}`);

  // When it makes another edit
  const extra = await agentEdits(w.srv, lease, id, { body: "v31" });

  // Then the server answers 429
  expect(extra.status).toBe(429);
  expect(Number(extra.headers["retry-after"])).toBeGreaterThan(0);
  expect((await byBody(w.owner, w.conv, "v30")).id).toBe(id);
});

scenario("An agent cannot delete someone else's message", { tag: ["@api"] }, async ({ server, dataDir }) => {
  // Given the owner posted a message in conversation 41
  const w = await msgWorld({ server, dataDir });
  const id = await ownerSays(w.owner, w.conv, "Owner's words");
  const lease = await leaseOf(w, "devtool");

  // When "devtool" deletes that message
  const res = await agentDeletes(w.srv, lease, id);

  // Then the server answers 403
  expect(res.status).toBe(403);
  expect((await byBody(w.owner, w.conv, "Owner's words")).deleted).toBeUndefined();
});

scenario("A message never moves to another conversation, thread or author", { tag: ["@api"] }, async ({ server, dataDir }) => {
  // Given a message in conversation 41
  const w = await msgWorld({ server, dataDir });
  const other = await createConversation(w.owner, { participants: ["devtool"], title: "Other" });
  const root = await ownerSays(w.owner, w.conv, "A root");
  const id = await ownerSays(w.owner, w.conv, "Stays here");

  // When a client sends an edit that sets a new conversation, thread root or author
  for (const [field, value] of [["conversation_id", other], ["thread_root_id", root], ["author_id", 2], ["author", "devtool"]] as const) {
    const res = await ownerEdits(w.owner, id, { body: "Moved", [field]: value });

    // Then the server answers 400
    expect(res.status, field).toBe(400);
    expect(errorOf(res).field).toBe(field);
  }

  // And the message is still in conversation 41 with the same author
  const kept = (await pageOf(w.owner, w.conv)).find((m) => m.id === id)!;
  expect(kept.body).toBe("Stays here");
  expect(kept.author.handle).toBe("drew");
  expect((await pageOf(w.owner, other)).map((m) => m.id)).not.toContain(id);
  expect(kept.thread_root_id).toBeUndefined();
});

scenario("Some messages cannot be edited", { tag: ["@api"] }, async ({ server, dataDir }) => {
  // Background
  const w = await msgWorld({ server, dataDir });
  const lease = await leaseOf(w, "devtool");
  const db = w.db();
  const ids = idsByHandle(db);
  const now = Date.now();
  // The ask and its answer belong to the asks work package and the app result to the apps one; until they land the rows are written
  // to the data file the way those modules write them, so the edit rule is tested on the rows it will meet.
  const insert = db.prepare("INSERT INTO messages (conversation_id, author_id, kind, format, body, answers_ask_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)");
  const askId = Number(insert.run(w.conv, ids.devtool!, "ask", "markdown", "", null, now).lastInsertRowid);
  db.prepare("INSERT INTO asks (message_id, conversation_id, asker_id, question, created_at, updated_at) VALUES (?, ?, ?, 'Which runner?', ?, ?)").run(
    askId,
    w.conv,
    ids.devtool!,
    now,
    now,
  );
  const answerId = Number(insert.run(w.conv, ids.drew!, "text", "plain", "vitest", askId, now).lastInsertRowid);
  const appId = must(await agentPostWith(w.srv, lease, w.conv, { body: "Pick one", app: appOf(300) }), "post an app", 201).json().id as number;
  const viaId = Number(
    db
      .prepare(
        "INSERT INTO messages (conversation_id, author_id, kind, format, body, via_app_agent_id, via_app_message_id, app_result_json, created_at) VALUES (?, ?, 'text', 'plain', 'Picked vitest', ?, ?, '{\"v\":1}', ?)",
      )
      .run(w.conv, ids.drew!, ids.devtool!, appId, now).lastInsertRowid,
  );
  const lineId = await systemLine(w, w.conv, { t: "member.left", identity: "devtool" });

  const rows: [string, number, "owner" | "agent"][] = [
    ["an ask", askId, "agent"],
    ["an answer to an ask", answerId, "owner"],
    ["a message sent through an app", viaId, "owner"],
    ["a system line", lineId, "owner"],
  ];
  for (const [what, id, who] of rows) {
    // When a client edits <message> in conversation 41
    const res = who === "owner" ? await ownerEdits(w.owner, id, { body: "Changed" }) : await agentEdits(w.srv, lease, id, { body: "Changed" });

    // Then the server answers 400
    expect(res.status, `${what}: ${res.text}`).toBe(400);

    // And the message is unchanged
    expect((await pageOf(w.owner, w.conv)).find((m) => m.id === id)?.edited_at, what).toBeUndefined();
  }
  const bodies = Object.fromEntries((db.prepare("SELECT id, body FROM messages WHERE id IN (?, ?, ?)").all(askId, answerId, viaId) as { id: number; body: string }[]).map((r) => [r.id, r.body]));
  expect(bodies).toEqual({ [askId]: "", [answerId]: "vitest", [viaId]: "Picked vitest" });
});

// ---- the loop breaker ---------------------------------------------------------------------------------------

scenario("The twentieth agent message in a row pauses the conversation", { tag: ["@api"] }, async ({ server, dataDir }) => {
  // Given "devtool" and "docs" posted 19 messages in a row in conversation 41
  const w = await msgWorld({ server, dataDir, participants: ["devtool", "docs"] });
  const dev = await leaseOf(w, "devtool");
  const docs = await leaseOf(w, "docs");
  await agentsPost(w, [dev, docs], w.conv, LOOP - 1);
  const db = w.db();
  const before = maxEventSeq(db);

  // When "docs" posts the twentieth
  const twentieth = await agentPost(w.srv, docs, w.conv, "The twentieth");
  expect(twentieth.status).toBe(201);

  // Then the owner sees the system line that the conversation is paused
  const lines = (await pageOf(w.owner, w.conv, "limit=100")).filter((m) => m.kind === "system");
  expect(lines.map((l) => l.system?.t)).toEqual(["conversation.paused"]);
  expect(lines[0]!.author.handle).toBe("");
  expect(lines[0]!.text).toBe("Paused after 20 agent messages in a row. Resume to let agents post.");

  // And the owner gets a "paused" notification (the event the notifications work package turns into a push)
  expect(eventTypesAfter(db, before)).toContain("conversation.paused.v1");
});

scenario("A human message lets agents post again", { tag: ["@api"] }, async ({ server, dataDir }) => {
  // Given conversation 41 is paused after 20 agent messages
  const w = await msgWorld({ server, dataDir, participants: ["devtool", "docs"] });
  const { dev } = await paused(w);
  expect((await agentPost(w.srv, dev, w.conv, "while paused")).status).toBe(429);

  // When the owner posts "carry on"
  must(await ownerPost(w.owner, w.conv, "carry on"), "owner posts", 201);

  // Then the next "convoz post" from "devtool" works
  const session = await startSession(w.box, "devtool", "carry-on");
  const res = await convoz(w.box, session.sid, ["post", String(w.conv), "back again"]);
  expect(res.code, res.stderr).toBe(0);
  expect((await byBody(w.owner, w.conv, "back again")).author.handle).toBe("devtool");
});

scenario("Thread replies count toward the loop", { tag: ["@api"] }, async ({ server, dataDir }) => {
  // Given "devtool" posted 19 thread replies in a row in conversation 41
  const w = await msgWorld({ server, dataDir, participants: ["devtool", "docs"] });
  const dev = await leaseOf(w, "devtool");
  const docs = await leaseOf(w, "docs");
  const root = await ownerSays(w.owner, w.conv, "Step 1 is the filter chips UI");
  for (let n = 1; n < LOOP; n++) must(await agentPostWith(w.srv, dev, w.conv, { body: `reply ${n}`, thread_root_id: root }), `reply ${n}`, 201);

  // When "docs" posts one more reply in the thread
  must(await agentPostWith(w.srv, docs, w.conv, { body: "reply 20", thread_root_id: root }), "the twentieth reply", 201);

  // Then conversation 41 is paused
  const page = await pageOf(w.owner, w.conv, "limit=100");
  expect(page.filter((m) => m.system?.t === "conversation.paused")).toHaveLength(1);
  expect(page.find((m) => m.id === root)?.reply_count).toBe(LOOP);
  expect(page.filter((m) => m.thread_root_id)).toHaveLength(0); // replies stay out of the main list
  expect((await agentPost(w.srv, dev, w.conv, "after the pause")).status).toBe(429);
});

scenario("While paused, agent posts and asks are refused", { tag: ["@api"] }, async ({ server, dataDir }) => {
  // Given conversation 41 is paused after 20 agent messages
  const w = await msgWorld({ server, dataDir, participants: ["devtool", "docs"] });
  const { dev } = await paused(w);

  // When "devtool" posts a message
  const post = await agentPost(w.srv, dev, w.conv, "One more");

  // Then the server answers 429
  expect(post.status).toBe(429);
  expect(errorOf(post).code).toBe("conversation_paused");
  expect(post.headers["retry-after"]).toBeUndefined();
  expect((await pageOf(w.owner, w.conv, "limit=100")).map((m) => m.body)).not.toContain("One more");

  // And an ask from "devtool" also answers 429: the rule is the message module's `Loop` port, which the asks module calls with the
  // same check (the ask routes arrive with that work package; until then a thread reply, which counts like an ask, is refused alike)
  const root = (await pageOf(w.owner, w.conv)).find((m) => !m.kind)!.id;
  const reply = await agentPostWith(w.srv, dev, w.conv, { body: "A reply", thread_root_id: root });
  expect(reply.status).toBe(429);
});

// ---- mentions -----------------------------------------------------------------------------------------------

scenario("An agent's mention does not add an agent", { tag: ["@api"] }, async ({ server, dataDir }) => {
  // Background
  const w = await msgWorld({ server, dataDir });
  const dev = await leaseOf(w, "devtool");
  const docs = await leaseOf(w, "docs");

  // When "devtool" posts "@docs can you review?" in conversation 41
  must(await agentPost(w.srv, dev, w.conv, "@docs can you review?"), "post", 201);

  // Then "docs" is not a participant of conversation 41
  expect(await participantsOf(w)).toEqual(["drew", "devtool"]);

  // And "docs" gets no inbox item for conversation 41
  expect(await itemsFor(w, docs)).toEqual([]);

  // (the mention itself is recorded: nobody is pulled in, but the message says whom it named)
  const named = w.db().prepare("SELECT i.handle AS handle FROM mentions m JOIN identities i ON i.id = m.identity_id").all() as { handle: string }[];
  expect(named.map((r) => r.handle)).toEqual(["docs"]);
});

scenario("Mentions inside code and quotes are ignored", { tag: ["@api"] }, async ({ server, dataDir }) => {
  // Background
  const w = await msgWorld({ server, dataDir });
  const db = w.db();
  const docsMentions = () => (db.prepare("SELECT COUNT(*) AS n FROM mentions m JOIN identities i ON i.id = m.identity_id WHERE i.handle = 'docs'").get() as { n: number }).n;

  for (const body of ["`@docs` is a handle", "```\n@docs\n```", "> @docs said this before"]) {
    // When the owner posts <body> in conversation 41
    must(await ownerPost(w.owner, w.conv, body), `owner posts ${JSON.stringify(body)}`, 201);

    // Then "docs" is not a participant of conversation 41
    expect(await participantsOf(w)).not.toContain("docs");
    expect(docsMentions(), body).toBe(0);
  }

  // (a mention outside code is recorded, so the zero above means something)
  must(await ownerPost(w.owner, w.conv, "Please look, @docs"), "owner posts", 201);
  expect(docsMentions()).toBe(1);
});

scenario("The server and the web app agree on mentions", { tag: ["@api"] }, async ({ server, dataDir }, info) => {
  info.setTimeout(120_000); // 10000 posts take 50 s on a busy box
  const w = await msgWorld({ server, dataDir, agents: ["devtool", "docs", "ops-bot"], participants: [] });
  const known = new Set(["drew", "devtool", "docs", "ops-bot"]);
  const render = createRenderer(null);
  const cases = [...mentionFixtures().map(({ body, format }) => ({ body, format })), ...fuzzBodies(10_000)];

  // When each body is posted through the API and rendered by the web app
  // The bodies go through the same post path as the API (message.Post), 500 to a transaction: 10000 separate commits are not what is under test.
  const ids: number[] = [];
  for (let from = 0; from < cases.length; from += 500) {
    const batch = cases.slice(from, from + 500).map(({ body, format }) => ({ body, format }));
    const res = await send(w.srv.target, "POST", "/__test/post-many", { json: { conversation: w.conv, author: "drew", messages: batch } });
    expect(res.status, res.text).toBe(200);
    ids.push(...(res.json().ids as number[]));
  }
  const db = w.db();
  const stored = new Map<number, string[]>();
  for (const r of db.prepare("SELECT m.message_id AS id, i.handle AS handle FROM mentions m JOIN identities i ON i.id = m.identity_id").all() as { id: number; handle: string }[]) {
    stored.set(Number(r.id), [...(stored.get(Number(r.id)) ?? []), r.handle]);
  }

  // Then the mentions the server stored equal the mentions the web app highlights for every body
  const wrong: string[] = [];
  cases.forEach((c, i) => {
    const shown = [...new Set(elements(render(c.body, { format: c.format, handles: known })).filter((e) => e.attrs?.class === "mention").map((e) => textOf(e).slice(1)))].sort();
    const kept = [...(stored.get(ids[i]!) ?? [])].sort();
    if (JSON.stringify(shown) !== JSON.stringify(kept)) wrong.push(`${c.format} ${JSON.stringify(c.body)}: server ${kept} web ${shown}`);
  });
  expect(wrong.slice(0, 5)).toEqual([]);
  for (const c of mentionFixtures()) expect(mentionsOf(c.body, c.format), c.name).toEqual(c.mentions); // the fixtures themselves
});

// ---- caps and budgets ---------------------------------------------------------------------------------------

scenario("A 16 KB body with a 64 KB app is accepted", { tag: ["@api"] }, async ({ server, dataDir }) => {
  // Background
  const w = await msgWorld({ server, dataDir });
  const lease = await leaseOf(w, "devtool");

  // When "devtool" posts a body of 16384 bytes with an app of 65536 bytes
  const res = await agentPostWith(w.srv, lease, w.conv, { body: "b".repeat(16384), app: appOf(65536) });

  // Then the server answers 201
  expect(res.status, res.text).toBe(201);
});

scenario("Oversized messages are refused", { tag: ["@api"] }, async ({ server, dataDir }) => {
  // Background
  const w = await msgWorld({ server, dataDir });
  const lease = await leaseOf(w, "devtool");
  const rows: [string, Record<string, unknown>, string][] = [
    ["a body of 16385 bytes", { body: "b".repeat(16385) }, "body"],
    ["an app of 65537 bytes", { body: "App", app: appOf(65537) }, "app"],
    ["11 attachments", { body: "Files", upload_ids: Array.from({ length: 11 }, (_, i) => `upl_${i}`) }, "upload_ids"],
    ["6 URLs", { body: Array.from({ length: 6 }, (_, i) => `https://example.com/${i}`).join(" ") }, "body"],
  ];
  for (const [problem, fields, field] of rows) {
    // When "devtool" posts a message with <problem>
    const res = await agentPostWith(w.srv, lease, w.conv, fields);

    // Then the server answers 400 naming "<field>"
    expect(res.status, `${problem}: ${res.text}`).toBe(400);
    expect(errorOf(res).field, problem).toBe(field);
  }
  expect((await pageOf(w.owner, w.conv)).filter((m) => m.author.handle === "devtool")).toHaveLength(0);
});

scenario("Every message type has one plain-text form, the same on the server and in the web app", { tag: ["@api"] }, async ({ server, dataDir }) => {
  // Given the projection fixtures: one message of each of the 10 variants plus a reply, a broadcast, an edit and an unfurl
  const w = await msgWorld({ server, dataDir });
  const fixtures = projectionFixtures();
  expect(fixtures.length).toBeGreaterThanOrEqual(14);

  for (const c of fixtures) {
    // When the server and the web app project each one to its short and long text
    const goes = must(await send(w.srv.target, "POST", "/__test/project", { json: { message: c.message } }), `project ${c.name}`).json();
    const web = { short: project(c.message, "short"), long: project(c.message, "long") };

    // Then both equal the expected strings in the fixtures
    expect(goes, `server: ${c.name}`).toEqual({ short: c.short, long: c.long });
    expect(web, `web app: ${c.name}`).toEqual({ short: c.short, long: c.long });
  }
});

scenario("A machine without the post scope cannot post", { tag: ["@api"] }, async ({ server, dataDir }) => {
  // Given machine "laptop-1" has no post scope and runs "docs"
  const w = await msgWorld({ server, dataDir, participants: ["devtool", "docs"] });
  const laptop = await loginMachine(w.srv, w.owner, "laptop-1", allow("docs"), { scopes: ["read", "ask", "status", "upload"] });
  const lease = must(await mintSession(w.srv, laptop.key, { as: "docs" }), "mint docs on laptop-1", 201).json().lease as string;

  // When "docs" on "laptop-1" posts in a conversation it is in
  const res = await agentPost(w.srv, lease, w.conv, "Hello");

  // Then the server answers 403
  expect(res.status).toBe(403);

  // And the same lease cannot edit or delete the message it wrote earlier from a machine that may post
  const earlier = must(await agentPost(w.srv, await leaseOf(w, "docs"), w.conv, "Written on box-2"), "post on box-2", 201).json().id as number;
  expect((await agentEdits(w.srv, lease, earlier, { body: "Rewritten" })).status).toBe(403);
  expect((await agentDeletes(w.srv, lease, earlier)).status).toBe(403);
  expect((await byBody(w.owner, w.conv, "Written on box-2")).deleted).toBeUndefined();
});

scenario("An agent over its burst is refused at once", { tag: ["@api"] }, async ({ server, dataDir }) => {
  // Given "devtool" is also in conversation 52
  const w = await msgWorld({ server, dataDir });
  const second = await createConversation(w.owner, { participants: ["devtool"], title: "Conversation 52" });
  const lease = await leaseOf(w, "devtool");

  // When "devtool" posts 21 messages in 1 second, alternating between conversations 41 and 52
  const answers = [];
  for (let n = 1; n <= 21; n++) answers.push(await agentPost(w.srv, lease, n % 2 ? w.conv : second, `burst ${n}`));

  // Then the twenty-first answers 429 with a Retry-After header
  expect(answers.slice(0, 20).map((a) => a.status)).toEqual(Array(20).fill(201));
  expect(answers[20]!.status).toBe(429);
  expect(Number(answers[20]!.headers["retry-after"])).toBeGreaterThanOrEqual(1);

  // (a thread reply is refused at once the same way: replies spend the same budget)
  const root = (await pageOf(w.owner, w.conv)).find((m) => m.body === "burst 1")!.id;
  expect((await agentPostWith(w.srv, lease, w.conv, { body: "A reply", thread_root_id: root })).status).toBe(429);

  // And the two conversations show 20 of them together
  const shown = [...(await pageOf(w.owner, w.conv)), ...(await pageOf(w.owner, second))].filter((m) => m.body.startsWith("burst "));
  expect(shown).toHaveLength(20);
});

scenario("A human write is not slowed by agents at their limits", { tag: ["@api"] }, async ({ server, dataDir }) => {
  // Given 10 agents post at their burst limit into conversation 41
  const bots = Array.from({ length: 10 }, (_, i) => `bot-${i + 1}`);
  const w = await msgWorld({ server, dataDir, agents: ["devtool", "docs", ...bots] });
  const leases = await Promise.all(bots.map((b) => leaseOf(w, b)));
  const own = await Promise.all(bots.map((b) => createConversation(w.owner, { participants: [b], title: `${b} notes` })));
  await Promise.all(leases.map((lease, i) => agentsPost(w, [lease], own[i]!, 20, `fill-${i}`))); // each bot has now used its burst of 20
  const flood = Promise.all(leases.map(async (lease) => {
    const answers = [];
    for (let n = 0; n < 10; n++) answers.push(await agentPost(w.srv, lease, w.conv, "more")); // every bot keeps trying while the owner writes
    return answers;
  }));

  // When the owner posts "stop for a moment"
  const times: number[] = [];
  for (let n = 0; n < 5; n++) {
    const started = performance.now();
    const res = await ownerPost(w.owner, w.conv, n === 0 ? "stop for a moment" : `stop for a moment ${n}`);
    times.push(performance.now() - started);
    expect(res.status).toBe(201);
  }

  // Then the owner's post answers 201 within 100 ms (the median of five, so one busy moment of the test machine does not decide)
  expect(times.sort((a, b) => a - b)[2]!).toBeLessThan(100);
  const answers = (await flood).flat();
  expect(answers.every((a) => a.status === 429), "every further agent post is refused before it writes").toBe(true);
});

scenario("A machine has a daily message budget across its identities", { tag: ["@api"] }, async ({ server, dataDir }) => {
  // Given identities on "box-2" posted 20000 messages today
  const w = await msgWorld({ server, dataDir, participants: ["devtool", "docs"] });
  const laptop = await loginMachine(w.srv, w.owner, "laptop-1", allow("docs"));
  await spendMachineBudget(w, w.box2.id, 20_000);
  const dev = await leaseOf(w, "devtool");
  const docsOnLaptop = must(await mintSession(w.srv, laptop.key, { as: "docs" }), "mint docs on laptop-1", 201).json().lease as string;

  // When "devtool" on "box-2" posts again
  const refused = await agentPost(w.srv, dev, w.conv, "One too many");

  // Then the server answers 429
  expect(refused.status).toBe(429);
  expect(Number(refused.headers["retry-after"])).toBeGreaterThan(0);

  // And "docs" on "laptop-1" can still post
  expect((await agentPost(w.srv, docsOnLaptop, w.conv, "From the laptop")).status).toBe(201);
});

// ---- system lines (the part that needs no browser) ----------------------------------------------------------

/** system.v1 (schemas/system.json) in the few lines it takes: which fields each subtype has. */
function systemV1(doc: Record<string, unknown>): boolean {
  const has = (...keys: string[]) => JSON.stringify(Object.keys(doc).sort()) === JSON.stringify(["t", "v", ...keys].sort());
  const ref = (k: string) => Number.isInteger(doc[k]) && (doc[k] as number) >= 1;
  if (doc.v !== 1) return false;
  switch (doc.t) {
    case "conversation.renamed": case "conversation.resumed": case "conversation.restored": case "pickup.opened":
      return has("by") && ref("by");
    case "member.left": case "member.disabled": case "pickup.taken":
      return has("identity") && ref("identity");
    case "member.requested": case "member.removed":
      return has("identity", "by") && ref("identity") && ref("by");
    case "member.added":
      return (has("identity", "by", "via") || has("identity", "by", "via", "history")) && ref("identity") && ref("by") && ["mention", "add", "create"].includes(doc.via as string) && (doc.history === undefined || ["since_now", "full"].includes(doc.history as string));
    case "conversation.paused":
      return has("streak") && doc.streak === 20;
    case "pickup.released":
      return has("identity", "reason") && ref("identity") && ["removed", "key_revoked", "disabled", "lease_expired"].includes(doc.reason as string);
  }
  return false;
}

scenario("System lines hold ids, never text", { tag: ["@api"] }, async ({ server, dataDir }) => {
  // Given a conversation titled "ZQX-title" with an agent named "ZQX-name"
  const w = await msgWorld({ server, dataDir, title: "ZQX-title", participants: ["devtool", "docs"] });
  await createAgent(w.owner, "zqx", "ZQX-name");
  const db = w.db();
  const before = maxEventSeq(db);

  // When each of the 12 system line subtypes is caused by its action
  // (the pause and the resume by their real actions; the ten that belong to the conversation work package by the system-line hook)
  const { dev } = await paused(w);
  expect((await agentPost(w.srv, dev, w.conv, "stopped")).status).toBe(429);
  must(await ownerResumes(w.owner, w.conv), "resume");
  const hooked: Record<string, unknown>[] = [
    { t: "member.added", identity: "zqx", by: "drew", via: "mention", history: "full" },
    { t: "member.requested", identity: "zqx", by: "devtool" },
    { t: "member.removed", identity: "zqx", by: "drew" },
    { t: "member.left", identity: "zqx" },
    { t: "member.disabled", identity: "zqx" },
    { t: "conversation.renamed", by: "drew" },
    { t: "conversation.restored", by: "drew" },
    { t: "pickup.opened", by: "drew" },
    { t: "pickup.taken", identity: "zqx" },
    { t: "pickup.released", identity: "zqx", reason: "key_revoked" },
  ];
  for (const line of hooked) await systemLine(w, w.conv, line);

  // Then each line is written in the same transaction as its action and matches system.v1
  const stored = (db.prepare("SELECT system_json AS j FROM messages WHERE kind = 'system' ORDER BY id").all() as { j: string }[]).map((r) => JSON.parse(r.j) as Record<string, unknown>);
  expect(new Set(stored.map((d) => d.t)).size).toBe(12);
  expect(stored.filter((d) => !systemV1(d)), "lines that do not match system.v1").toEqual([]);
  const events = eventTypesAfter(db, before);
  expect(events).toContain("conversation.paused.v1");
  expect(events).toContain("conversation.resumed.v1");

  // And no stored system line contains either seeded string
  expect(rowsWith(db, "ZQX-name").filter((r) => r.startsWith("messages:"))).toEqual([]);
  expect((db.prepare("SELECT COUNT(*) AS n FROM messages WHERE kind = 'system' AND (system_json LIKE '%ZQX-title%' OR system_json LIKE '%ZQX-name%' OR body <> '')").get() as { n: number }).n).toBe(0);
});

// ---- what the owner sees in the browser ---------------------------------------------------------------------

/** A world like msgWorld with the owner's browser signed in (all API step-ups first: the passkey counter continues from there). */
async function browserWorld(fx: { server: Parameters<typeof msgWorld>[0]["server"]; dataDir: string; page: Page; context: BrowserContext }, o: Partial<Parameters<typeof msgWorld>[0]> = {}): Promise<MsgWorld> {
  const w = await msgWorld({ ...o, server: fx.server, dataDir: fx.dataDir });
  await signInBrowser(w.srv, w.owner, fx.page, fx.context);
  return w;
}

const article = (page: Page, text: string | RegExp) => messageLog(page).getByRole("article").filter({ hasText: text });

scenario("A system line has no author and cannot be replied to", { tag: ["@browser"] }, async ({ server, dataDir, page, context, testApi }) => {
  // Given the owner added "docs" to conversation 41 (the line the add action writes; the add itself is the conversation module's)
  const w = await browserWorld({ server, dataDir, page, context }, { participants: ["devtool", "docs"] });
  const line = await systemLine(w, w.conv, { t: "member.added", identity: "docs", by: "drew", via: "add" });
  await page.goto(`${w.srv.origin}/chats/${w.conv}`);

  // Then the owner sees the system line "Added @docs" with no author and no reply action
  const notice = messageLog(page).getByRole("note").filter({ hasText: "Added @docs" });
  await expect(notice).toBeVisible();
  await expect(notice).toHaveText("Added @docs");
  await expect(messageLog(page).getByRole("article")).toHaveCount(0); // a line is not an article: no avatar, no name
  await expect(notice.getByRole("button")).toHaveCount(0);

  // And a reply to that line is refused: the server answers 400 system_line_no_replies
  // (there is no `convoz reply` command in this build, so the exit-2 half of this Then is not exercised)
  const reply = await ownerPostWith(w.owner, w.conv, { body: "Replying to a line", thread_root_id: line });
  expect(reply.status).toBe(400);
  expect(errorOf(reply).code).toBe("system_line_no_replies");
});

scenario("A system line shows the current name after a rename", { tag: ["@browser"] }, async ({ server, dataDir, page, context, testApi }) => {
  // Given the system line "Added @devtool" in conversation 41
  const w = await browserWorld({ server, dataDir, page, context });
  await systemLine(w, w.conv, { t: "member.added", identity: "devtool", by: "drew", via: "add" });
  await page.goto(`${w.srv.origin}/chats/${w.conv}`);
  await expect(messageLog(page).getByRole("note")).toHaveText("Added @devtool");

  // When "devtool" changes its display name to "Dev Tool"
  // (the rename action belongs to the crew module; the stored name is changed in the data file, which is all a rename does)
  w.db().prepare("UPDATE identities SET display_name = 'Dev Tool' WHERE handle = 'devtool'").run();
  await page.reload();

  // Then the line reads with the name "Dev Tool" and the handle "@devtool"
  await expect(messageLog(page).getByRole("note")).toHaveText("Added Dev Tool @devtool");
  const stored = w.db().prepare("SELECT system_json AS j FROM messages WHERE kind = 'system'").get() as { j: string };
  expect(stored.j).not.toContain("Dev Tool"); // the line holds ids; the name is looked up when read
});

scenario("Deleting a message leaves a tombstone", { tag: ["@browser"] }, async ({ server, dataDir, page, context, testApi }) => {
  // Given the owner posted "wrong channel" in conversation 41
  const w = await browserWorld({ server, dataDir, page, context });
  await ownerSays(w.owner, w.conv, "wrong channel");
  await page.goto(`${w.srv.origin}/chats/${w.conv}`);
  const row = article(page, "wrong channel");
  await expect(row).toBeVisible();

  // When the owner deletes it
  await row.hover();
  await row.getByRole("button", { name: "Message actions" }).click();
  await page.getByRole("menuitem", { name: "Delete" }).click();
  await page.getByRole("dialog", { name: "Delete this message?" }).getByRole("button", { name: "Delete" }).click();

  // Then conversation 41 shows "Message deleted" in its place
  await expect(article(page, "Message deleted")).toBeVisible();
  await expect(messageLog(page)).not.toContainText("wrong channel");
  expect((await pageOf(w.owner, w.conv)).map((m) => m.body)).toEqual([""]);
});

scenario("An edit never pulls anyone in", { tag: ["@browser", "@api"] }, async ({ server, dataDir, page, context, testApi }) => {
  // Given "devtool" posted "Build is green" 1 hour ago
  const w = await browserWorld({ server, dataDir, page, context }, { participants: ["devtool"], agents: ["devtool", "docs"] });
  const lease = await leaseOf(w, "devtool");
  const docs = await leaseOf(w, "docs");
  const id = must(await agentPost(w.srv, lease, w.conv, "Build is green"), "post", 201).json().id as number;
  await testApi(w.srv).advanceClock(3_600_000);
  const db = w.db();
  const before = maxEventSeq(db);

  // When "devtool" edits it to "Build is green, @docs please check"
  expect((await agentEdits(w.srv, lease, id, { body: "Build is green, @docs please check" })).status).toBe(200);
  const events = eventTypesAfter(db, before);

  // Then the owner sees the new text marked "(edited)" with its history
  await page.goto(`${w.srv.origin}/chats/${w.conv}`);
  const row = article(page, "please check");
  await expect(row).toBeVisible();
  await row.getByRole("button", { name: "(edited)" }).click();
  await expect(page.getByRole("dialog", { name: "Edit history" })).toContainText("Build is green");

  // And "docs" is not added and gets no inbox item
  expect(await participantsOf(w)).toEqual(["drew", "devtool"]);
  expect(await itemsFor(w, docs)).toEqual([]);
  expect((db.prepare("SELECT COUNT(*) AS n FROM mentions").get() as { n: number }).n).toBe(0);

  // And the owner gets no push for the edit: the only event is message.edited.v1, which no notification rule reads
  expect(events).toEqual(["message.edited.v1"]);
});

scenario("A deleted message is gone everywhere at once", { tag: ["@browser", "@cli"] }, async ({ server, dataDir, page, context, testApi }) => {
  // Given "devtool" posted "ZQX-delete-me" in conversation 41
  // (the file "plan.pdf" belongs to the upload module; its half of this scenario is not exercised)
  const w = await browserWorld({ server, dataDir, page, context });
  const session = await startSession(w.box, "devtool", "gone");
  expect((await convoz(w.box, session.sid, ["post", String(w.conv), "ZQX-delete-me"])).code).toBe(0);
  const id = (await byBody(w.owner, w.conv, "ZQX-delete-me")).id;
  expect((await searchAs(w, "ZQX-delete-me")).results.map((r) => r.message_id), "search finds it until it is deleted").toEqual([id]);
  await page.goto(`${w.srv.origin}/chats/${w.conv}`);
  await expect(article(page, "ZQX-delete-me")).toBeVisible();

  // When the owner deletes the message
  expect((await ownerDeletes(w.owner, id)).status).toBe(200);

  // Then the conversation shows "Message deleted" in its place
  await expect(article(page, "Message deleted")).toBeVisible({ timeout: 5_000 }); // by the live frame, no reload
  await expect(messageLog(page)).not.toContainText("ZQX-delete-me");

  // And searching "ZQX-delete-me" finds nothing
  expect((await searchAs(w, "ZQX-delete-me")).results).toEqual([]);

  // And "convoz read 41" shows "[deleted]" in its place
  const read = await convoz(w.box, session.sid, ["read", String(w.conv)]);
  expect(read.stdout).toContain("[deleted]");
  expect(read.stdout).not.toContain("ZQX-delete-me");
  expect(w.db().prepare("SELECT body FROM message_rows WHERE id = ?").get(id)).toEqual({ body: "" });
});

scenario("The owner resumes a paused conversation", { tag: ["@browser"] }, async ({ server, dataDir, page, context, testApi }) => {
  // Given conversation 41 is paused after 20 agent messages
  const w = await browserWorld({ server, dataDir, page, context }, { participants: ["devtool", "docs"] });
  await paused(w);
  await page.goto(`${w.srv.origin}/chats/${w.conv}`);
  const resume = messageLog(page).getByRole("button", { name: "Resume" });
  await expect(resume).toBeVisible();

  // When the owner taps Resume
  await resume.click();
  await expect(resume).toHaveCount(0);
  await expect(messageLog(page).getByRole("note").last()).toHaveText("@drew resumed the conversation");

  // Then the next "convoz post" from "devtool" works
  const session = await startSession(w.box, "devtool", "resumed");
  const res = await convoz(w.box, session.sid, ["post", String(w.conv), "Back at it"]);
  expect(res.code, res.stderr).toBe(0);
});

scenario("An agent that posts too fast is slowed down, not failed", { tag: ["@cli"] }, async ({ server, dataDir }, info) => {
  info.setTimeout(120_000);
  // Background
  const w = await msgWorld({ server, dataDir });
  const session = await startSession(w.box, "devtool", "fast");

  // When "devtool" runs "convoz post 41" 25 times within one second
  const sent: string[] = [];
  for (let n = 1; n <= 25; n++) {
    // the window is 20 seconds wide, so the 21st post waits for the first to leave it: a long run, not a quick one
    const res = await w.box.run(["post", "--sid", session.sid, "--timeout", "10s", String(w.conv), `fast ${n}`], { timeoutMs: 80_000 });
    expect(res.code, `post ${n}: ${res.stderr}`).toBe(0);
    sent.push(`fast ${n}`);
    // I-16 would pause conversation 41 at the 20th agent message in a row, so the owner writes now and then (a person resets the count)
    if (n % 10 === 0) must(await ownerPost(w.owner, w.conv, `owner ${n}`), "owner posts", 201);
  }

  // Then all 25 messages arrive in order
  const shown = (await pageOf(w.owner, w.conv, "limit=100")).filter((m) => m.author.handle === "devtool").map((m) => m.body);
  expect(shown).toEqual(sent);

  // And the CLI waited whenever Convoz asked it to slow down: the server did refuse some posts, and none was lost
  expect(w.srv.log().match(/POST \/api\/conversations\/\d+\/messages 429/g)?.length ?? 0).toBeGreaterThan(0);
});

scenario("A deleted message serves nothing and a purge leaves no copy", { tag: ["@api"] }, async ({ server, dataDir }) => {
  // Given "devtool" posted an app message with the body "ZQX-gone", and the owner sent a result through it
  // (the file and GET /api/messages/:id/app belong to the upload and app modules; this covers the rows the message module owns)
  const w = await msgWorld({ server, dataDir });
  const lease = await leaseOf(w, "devtool");
  const app = { v: 1, type: "code", title: "ZQX-gone", fallback: "ZQX-gone", props: { mode: "code", text: "ZQX-gone" } };
  const id = must(await agentPostWith(w.srv, lease, w.conv, { body: "ZQX-gone", app }), "post an app", 201).json().id as number;
  const db = w.db();
  const ids = idsByHandle(db);
  const viaId = Number(
    db
      .prepare(
        "INSERT INTO messages (conversation_id, author_id, kind, format, body, via_app_agent_id, via_app_message_id, app_result_json, created_at) VALUES (?, ?, 'text', 'plain', 'ZQX-gone', ?, ?, '{\"v\":1,\"text\":\"ZQX-gone\"}', ?)",
      )
      .run(w.conv, ids.drew!, ids.devtool!, id, Date.now()).lastInsertRowid,
  );
  expect(rowsWith(db, "ZQX-gone").length).toBeGreaterThan(0);
  db.close();

  // When the owner deletes the app message
  expect((await ownerDeletes(w.owner, id)).status).toBe(200);

  // Then every read answers without it: the page holds a tombstone and its history is not served
  const tomb = (await pageOf(w.owner, w.conv)).find((m) => m.id === id)!;
  expect([tomb.deleted, tomb.body]).toEqual([true, ""]);
  expect(JSON.stringify(tomb)).not.toContain("ZQX-gone");
  expect((await w.owner.client.get(`/api/messages/${id}/edits`)).status).toBe(404);

  // And after a purge with a passkey, a scan of every table finds the body, app and result strings 0 times
  for (const purged of [id, viaId]) expect((await ownerPurges(w.owner, purged)).status).toBe(200);
  const after = w.db();
  expect(rowsWith(after, "ZQX-gone")).toEqual([]);
  after.close();
});
