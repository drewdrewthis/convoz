/*
 * CHAT MVP, PR 1 CONTRACT (server API and CLI). One source for the coder. Sources: the chat MVP plan (with its "DA amendments" and
 * "Advisor decisions after DA"), design draft 9 §3.8, §7, §8.2, §13, §13.2. Where this block and the plan differ, this block is what
 * the bindings in chat-api.spec.ts and chat-cli.spec.ts assert; the PR summary lists each difference.
 * Builds on the S1b contract at the top of tests/machine-login.spec.ts (auth letters O owner device cookie, L session lease,
 * errors `{"error":{"code","message"[,"field"]}}`). Every write carries `client_id` (8 to 64 characters). Unknown body fields: 400
 * invalid_request with `field`. A lease needs no Origin or X-Convoz header; a cookie write needs both (S1a).
 *
 * ROUTES (H = owner cookie, L = lease)
 *   POST /api/conversations  H  {client_id, title?, participants:[handle]}
 *        -> 201 {conversation:{id, title, created_at, last_activity_at, participants, last, unread}}  (shape of a list row, below).
 *        The owner is a participant. Each listed agent is an active participant at once. Same client_id again -> 200 and the same id.
 *        A lease -> 403. Unknown or disabled handle -> 400 invalid_request, field "participants".
 *   GET  /api/conversations  H, L
 *        -> 200 {conversations:[{id, title|null, created_at, last_activity_at, participants:[{handle,display_name,kind}],
 *           last:{id, author_handle, preview (<=140 runes, one line)}|null, unread}]}
 *        ORDER: last_activity_at DESC, id DESC (plan DA amendment 3: latest activity first, not creation order). A conversation with
 *        no message has last_activity_at = created_at. A lease sees only conversations it is an active participant of.
 *        `unread` = main messages after the caller's read cursor that the caller did not write (design §8.2), capped at 100.
 *   GET  /api/conversations/:id  H, L -> 200 {conversation:{...}}; not visible -> 404
 *   GET  /api/conversations/:id/messages?before=&after=&limit=  H, L
 *        -> 200 {messages:[{id, author:{handle,display_name,kind}, body, format, created_at, session_label?, machine?}], as_of_seq}
 *        Always oldest first. No query: the newest `limit` (default 50, max 100). after=N: the oldest `limit` with id > N.
 *        before=N: the newest `limit` with id < N. A lease sees only messages with id > its participant joined_message_id.
 *        Not visible -> 404.
 *   POST /api/conversations/:id/messages  H, L (+ post scope)  {client_id, body, format?:"markdown"|"markdownv2"|"plain"}
 *        -> 201 {id, conversation_id, created_at}. Same client_id and same body and format again -> 200 with the first id and no
 *        second message. Same client_id with another body or format -> 409 client_id_conflict. A lease that is not an active
 *        participant -> 403 forbidden. Any other field (for example "author") -> 400 invalid_request with field.
 *        Body over 16384 bytes -> 400 too_large (field "body"). Per agent identity 1 per second, burst 20 -> 429.
 *        The author is always the caller (I-40). Auto title: if the conversation has no title, the first 60 runes of the first message.
 *   POST /api/conversations/:id/read  H, L  {main_id} -> 200 {}. Forward only: a lower id is a no-op.
 *        The author of a message moves its own cursor to that message only if the cursor was at the newest main message
 *        just before the post (`last_read_main_id >= previous last_main_id`, plan DA-2 / I-15). Otherwise the cursor stays.
 *   GET  /api/identities  H  (S1a) every agent row gains `online:boolean`: true when the agent has a live lease on any machine.
 *   GET  /api/inbox?wait=&claim=&visibility=&peek=  L
 *        -> 200 {items:[{id, claim_token, state:"claimed", reason:"activity", count, conversation:{id,title},
 *           message:{id, author:{handle,display_name,kind}, body, format, created_at}}]}
 *        `message` is the newest message of the item. The item exists once per (identity, conversation) while ready; it is made by
 *        the same transaction as the message (I-43). Reasons in PR 1: "activity" only. NEVER an item for the author's own identity
 *        (other sessions of that identity included). Humans have no inbox.
 *        Without peek: the caller's held items (claimed by this session, claim not expired) first, then claim up to `claim`
 *        ready items (default 20) with visibility `visibility` (a duration "30s", min 30 s, max 30 min, default 5 min).
 *        An item whose claim passed is ready again with a NEW claim_token and goes to any session (design §3.8 SQL).
 *        wait=S: if nothing, hold up to S seconds (max 25), woken by new items; then 200 {items:[]}. wait=0 answers at once.
 *        Ending the lease (DELETE /api/sessions/me) answers a held poll of that lease at once with 401 session_ended.
 *        peek=1: no claim, no change; lists the identity's items that are ready or claimed (`state`), without claim_token for ready.
 *        A claim writes a live-only frame `agent.working` (below).
 *   POST /api/inbox/ack  L  {items:[{id, claim_token}]} -> 200 {results:[{id, result:"ok"|"claim_lost"}]}  An acked item is gone
 *        from peek. A wrong or old token, or an item already acked, is "claim_lost".
 *   GET  /api/stream  H  text/event-stream. Frames `event: <type>`, `id: <epoch>:<seq>`, `data: <json>`; `: hb` comment every 15 s.
 *        Types in PR 1: message.created {id, conversation_id, author_handle, ...}, read.moved, conversation.created, and the
 *        LIVE-ONLY frame agent.working (no `id`, never replayed, no table):
 *          agent.working  data {identity_id, handle, conversation_id, working:boolean}
 *        working:true is sent when that agent claims an item for the conversation. working:false is sent when the agent posts in
 *        that conversation, or when the claim ends without a post (ack, expiry). Last-Event-ID resumes from seq+1.
 *
 * EVENTS TABLE (migration 0007 rebuilds it to the design §7 shape)
 *   events(seq INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT CHECK (type GLOB '[a-z]*.[a-z_]*.v[0-9]*'), actor_id, session_id,
 *   conversation_id, audience_id, message_id, payload_json TEXT, idem_key, created_at) STRICT, unique index events_idem,
 *   trigger "events are immutable" on UPDATE. Old rows are copied with the same id (now `seq`), payload (now `payload_json`) and
 *   created_at; the type gets ".v1" appended ("identity.created" -> "identity.created.v1"). New: "message.created.v1".
 *
 * CLI (global flags --server, --as/CONVOZ_AS, --sid/CONVOZ_SID, --json, --timeout; FLAGS GO BEFORE POSITIONAL ARGUMENTS)
 *   exit codes: 0 ok, 1 other, 2 usage, 3 auth (401, 403), 4 conflict (409, claim_lost), 5 rate limited, 6 network.
 *   convoz post [--format F] [--client-id C] <conv> <text|->
 *        stdout: the message id and a newline, nothing else. --json: {"id":N,"conversation_id":C}. `-` reads the text from stdin.
 *        A lost answer is retried with the same client id (<=3 tries within --timeout).
 *   convoz read [--since ID] [--limit N] <conv>
 *        stdout: per message, oldest first, `#<id> @<handle> <RFC3339 time>` then the body, each body line indented 2 spaces.
 *        --json: {"messages":[...same as the messages route...]}. Moves the agent's read cursor to the newest id shown.
 *   convoz inbox [--wait S] [--peek] [--claim N] [--visibility D]
 *        stdout: one line per item `<id>:<token> conv <c> "<title>" <reason> x<count> #<msg> @<author>: <first line of body>`
 *        (peek: `<id>` without `:<token>`). --json: {"items":[...as the route...]}. No item: no stdout, exit 0.
 *   convoz ack <id:token>...   stdout one line per item `<id> ok` or `<id> claim_lost`; any claim_lost -> exit 4.  --json: {"results":[...]}
 *   convoz watch --json
 *        Loops GET /api/inbox?wait=25 and writes ONE line of JSON per item to stdout, flushed, and does NOT ack (plan DA amendment 5):
 *          {"item_id","claim_token","reason","conversation_id","conversation_title","count","message_id","author","body","created_at"}
 *        Newlines in the body are escaped by JSON. An item is printed once per claim_token: a held item is not printed again until
 *        its claim expires and it is re-claimed with a new token. The agent runs `convoz ack <item_id>:<claim_token>` after it posts.
 *        Lease ended: stderr "convoz: The session ended. ...", exit 3. Network errors: retry with backoff <=30 s, keep running.
 *        (claim_token is NOT in the plan's line; the agent needs it to ack, so it is added here.)
 *
 * TEST BUILD  CONVOZ_TEST_MAX_MIGRATION=<n> stops migrating at schema n; CONVOZ_TEST_PLAINTEXT=1 opens the data file unencrypted.
 *   POST /__test/clock {advance_ms} moves the server clock (claim expiry, last_activity_at). Real time keeps flowing.
 *
 * Labels like "conversation 41" in the specs are the test's own names; the real ids come from the server.
 */
import { DatabaseSync } from "node:sqlite";
import { allow, bearer, createAgents, lease, loginMachine, plainDb } from "../lib/machines.ts";
import {
  agentPost,
  agentSays,
  chatWorld,
  createConversation,
  listConversations,
  messagesOf,
  openStream,
  ownerPost,
  ownerReads,
  ownerSays,
  unreadOf,
} from "../lib/chat.ts";
import { send } from "../lib/http.ts";
import { bootstrapOwner, must } from "../lib/owner.ts";
import { expect, scenario } from "../lib/scenario.ts";

// ---- platform.feature (contracts): every command can be retried safely ------------------------------------

scenario("The same client id returns the first result", { tag: ["@api"] }, async ({ server }) => {
  // Given the owner posted "ship it" with client id "c-0001-aaaa"
  const w = await chatWorld(server, { agents: ["devtool"] });
  const conv = await createConversation(w.owner, { title: "Ship search filters", participants: ["devtool"] });
  const first = must(await ownerPost(w.owner, conv, "ship it", { clientId: "c-0001-aaaa" }), "first post", 201).json();

  // When the owner posts "ship it" again with client id "c-0001-aaaa"
  const again = await ownerPost(w.owner, conv, "ship it", { clientId: "c-0001-aaaa" });

  // Then the server returns the first message's id
  expect(again.status).toBe(200);
  expect(again.json().id).toBe(first.id);

  // And conversation 41 shows "ship it" once
  const shown = (await messagesOf(w.owner, conv)).filter((m) => m.body === "ship it");
  expect(shown).toHaveLength(1);
});

scenario("The same client id with a different body is a conflict", { tag: ["@api"] }, async ({ server }) => {
  // Given the owner posted "ship it" with client id "c-0002-aaaa"
  const w = await chatWorld(server, { agents: ["devtool"] });
  const conv = await createConversation(w.owner, { title: "Ship search filters", participants: ["devtool"] });
  must(await ownerPost(w.owner, conv, "ship it", { clientId: "c-0002-aaaa" }), "first post", 201);

  // When the owner posts "hold it" with client id "c-0002-aaaa"
  const res = await ownerPost(w.owner, conv, "hold it", { clientId: "c-0002-aaaa" });

  // Then the server answers 409
  expect(res.status).toBe(409);
  expect(res.json().error.code).toBe("client_id_conflict");
});

// ---- messages-types.feature (contracts): the server decides who wrote a message ----------------------------

scenario("An agent cannot post under another name", { tag: ["@api"] }, async ({ server }) => {
  // Given "devtool" is an active participant of conversation 41 and holds a lease
  const w = await chatWorld(server, { agents: ["devtool", "docs"] });
  const conv = await createConversation(w.owner, { title: "Ship search filters", participants: ["devtool"] });
  const token = await lease(w.srv, w.box2.key, { as: "devtool" });

  // When "devtool" posts with an extra body field "author" set to "drew"
  const res = await agentPost(w.srv, token, conv, "I am the owner", { author: "drew" });

  // Then the server answers 400 for the unknown field
  expect(res.status).toBe(400);
  expect(res.json().error.field).toBe("author");

  // And conversation 41 shows no message from "drew"
  const fromDrew = (await messagesOf(w.owner, conv)).filter((m) => m.author.handle === "drew");
  expect(fromDrew).toEqual([]);
});

scenario("An agent cannot post where it is not a participant", { tag: ["@api"] }, async ({ server }) => {
  // Given conversation 52 has only "docs" and the owner, and "devtool" holds a lease
  const w = await chatWorld(server, { agents: ["devtool", "docs"] });
  await createConversation(w.owner, { title: "Ship search filters", participants: ["devtool"] });
  const other = await createConversation(w.owner, { title: "Deploy alerts runbook", participants: ["docs"] });
  const token = await lease(w.srv, w.box2.key, { as: "devtool" });

  // When "devtool" posts in conversation 52 where it is not a participant
  const res = await agentPost(w.srv, token, other, "let me in");

  // Then the server answers 403
  expect(res.status).toBe(403);
});

// ---- conversations.feature (contracts): read position is honest ---------------------------------------------

scenario("My post marks the conversation read only when I was caught up", { tag: ["@api"] }, async ({ server }) => {
  // Given the owner read conversation 41 up to message 100 (here: the first agent message)
  const w = await chatWorld(server, { agents: ["devtool"] });
  const conv = await createConversation(w.owner, { title: "Ship search filters", participants: ["devtool"] });
  const token = await lease(w.srv, w.box2.key, { as: "devtool" });
  const seen = await agentSays(w.srv, token, conv, "message 100");
  await ownerReads(w.owner, conv, seen);

  // And "devtool" posted messages 101, 102 and 103
  for (const n of [101, 102, 103]) await agentSays(w.srv, token, conv, `message ${n}`);

  // When the owner posts "on my way" through the API without reading them
  await ownerSays(w.owner, conv, "on my way");

  // Then GET /api/conversations shows 3 unread for conversation 41
  expect(await unreadOf(w.owner, conv)).toBe(3);
});

scenario("My post marks the conversation read when I was caught up", { tag: ["@api"] }, async ({ server }) => {
  // Given the owner read conversation 41 up to its newest message
  const w = await chatWorld(server, { agents: ["devtool"] });
  const conv = await createConversation(w.owner, { title: "Ship search filters", participants: ["devtool"] });
  const token = await lease(w.srv, w.box2.key, { as: "devtool" });
  const newest = await agentSays(w.srv, token, conv, "latest news");
  await ownerReads(w.owner, conv, newest);

  // When the owner posts "on my way"
  await ownerSays(w.owner, conv, "on my way");

  // Then GET /api/conversations shows 0 unread for conversation 41
  expect(await unreadOf(w.owner, conv)).toBe(0);
});

// ---- conversations.feature (contracts): list order, online, working (new) -----------------------------------

scenario("The conversation list orders by latest activity", { tag: ["@api"] }, async ({ server, testApi }) => {
  // Given conversations 41, 52 and 60 were created in that order with "devtool"
  const w = await chatWorld(server, { agents: ["devtool"] });
  const c41 = await createConversation(w.owner, { title: "Ship search filters", participants: ["devtool"] });
  const c52 = await createConversation(w.owner, { title: "Deploy alerts runbook", participants: ["devtool"] });
  const c60 = await createConversation(w.owner, { title: "Weekly usage", participants: ["devtool"] });
  const token = await lease(w.srv, w.box2.key, { as: "devtool" });
  await testApi(w.srv).advanceClock(2_000); // the post is later than every creation, whatever the clock resolution

  // When "devtool" posts in conversation 41
  await agentSays(w.srv, token, c41, "Build is green");

  // Then GET /api/conversations lists 41, 60, 52 in that order
  expect((await listConversations(w.owner)).map((c) => c.id)).toEqual([c41, c60, c52]);
});

scenario("An agent with a live session shows online", { tag: ["@api"] }, async ({ server }) => {
  // Given "docs" has no live session and "devtool" has one
  const w = await chatWorld(server, { agents: ["devtool", "docs"] });
  await lease(w.srv, w.box2.key, { as: "devtool" });

  // When the owner calls GET /api/identities
  const rows = must(await w.owner.client.get("/api/identities"), "identities").json().identities as { handle: string; online?: boolean }[];

  // Then "devtool" is online and "docs" is not
  const online = Object.fromEntries(rows.filter((r) => ["devtool", "docs"].includes(r.handle)).map((r) => [r.handle, r.online]));
  expect(online).toEqual({ devtool: true, docs: false });
});

scenario("An agent shows working while it holds an item and stops when it replies", { tag: ["@api"] }, async ({ server }) => {
  // Given the owner has the event stream open
  const w = await chatWorld(server, { agents: ["devtool"] });
  const conv = await createConversation(w.owner, { title: "Ship search filters", participants: ["devtool"] });
  const token = await lease(w.srv, w.box2.key, { as: "devtool" });
  await ownerSays(w.owner, conv, "Is the build green?");
  const stream = await openStream(w.srv, w.owner.client);
  try {
    expect(stream.status).toBe(200);
    const working = (on: boolean) => (f: { event: string; data: any }) =>
      f.event === "agent.working" && f.data?.handle === "devtool" && f.data?.conversation_id === conv && f.data?.working === on;

    // When "devtool" claims the item for conversation 41
    must(await send(w.srv.target, "GET", "/api/inbox?claim=1&wait=0", bearer(token)), "claim");

    // Then the stream sends "agent.working" for "devtool" with working true
    await stream.waitFor(working(true));

    // When "devtool" posts in conversation 41
    await agentSays(w.srv, token, conv, "Yes, all 11 checks pass");

    // Then the stream sends "agent.working" for "devtool" with working false
    const stop = await stream.waitFor(working(false));
    expect(stop.id).toBeUndefined(); // live-only: never replayed
  } finally {
    stream.close();
  }
});

// ---- platform.feature (contracts): upgrades are forward only and safe ---------------------------------------

scenario("The events table is rebuilt in its final shape and keeps every row", { tag: ["@cli"] }, async ({ dataDir, server }) => {
  // Given a data dir at the previous release's schema (S1b, migration 6) with events from sign-up and Crew
  const plain = { CONVOZ_TEST_PLAINTEXT: "1" };
  const old = await server({ host: "localhost", adminSocket: true, env: { ...plain, CONVOZ_TEST_MAX_MIGRATION: "6" } });
  const owner = await bootstrapOwner(old);
  await createAgents(owner, "devtool", "docs");
  await loginMachine(old, owner, "box-2", allow("devtool"));
  await old.stop();
  const before = readEvents(plainDb(dataDir), "SELECT id, type, payload, created_at FROM events ORDER BY id");
  expect(before.length).toBeGreaterThan(3);

  // When this build starts and migrates it
  await server({ host: "localhost", adminSocket: true, env: plain });

  // Then every old event keeps its id, payload and time, and its type ends in ".v1"
  const after = readEvents(plainDb(dataDir), "SELECT seq AS id, type, payload_json AS payload, created_at FROM events ORDER BY seq").slice(0, before.length);
  expect(after).toEqual(before.map((r) => ({ ...r, type: `${r.type}.v1` })));

  const db = plainDb(dataDir);
  try {
    // And the events table has the final columns, an autoincrement id and no update path
    const columns = (db.prepare("PRAGMA table_info(events)").all() as { name: string }[]).map((c) => c.name);
    expect(columns).toEqual([
      "seq", "type", "actor_id", "session_id", "conversation_id", "audience_id", "message_id", "payload_json", "idem_key", "created_at",
    ]);
    const ddl = (db.prepare("SELECT sql FROM sqlite_master WHERE name = 'events'").get() as { sql: string }).sql;
    expect(ddl).toMatch(/AUTOINCREMENT/);
    expect(() => db.exec("UPDATE events SET created_at = 1")).toThrow(/immutable/);
  } finally {
    db.close();
  }
});

interface EventRow {
  id: number;
  type: string;
  payload: string;
  created_at: number;
}

/** Read event rows and close the connection (a second connection to the live file, as the X-1 probes do). */
function readEvents(db: DatabaseSync, sql: string): EventRow[] {
  try {
    return (db.prepare(sql).all() as unknown as EventRow[]).map((r) => ({ id: r.id, type: r.type, payload: r.payload, created_at: r.created_at }));
  } finally {
    db.close();
  }
}
