import { ownerAdds } from "../lib/wp3.ts";
import {
  asDevtool,
  briefWorld,
  CONVERSATIONS,
  listedConversations,
  McpClient,
  machineVia,
  NOTE_FIRST,
  occurrences,
  sectionOf,
  unreadConversations,
} from "../lib/agent-wp7.ts";
import { convoz, createConversation, inboxItems, ownerSays, startSession } from "../lib/chat.ts";
import { faultProxy } from "../lib/fault-proxy.ts";
import { send } from "../lib/http.ts";
import { bearer } from "../lib/machines.ts";
import { idsByHandle, pageOf } from "../lib/messages-wp4.ts";
import { expect, scenario } from "../lib/scenario.ts";

/*
 * BRIEF AND HANDOFF (WP7): specs/features/brief-handoff.feature. The routes, the CLI and the text of the brief are the block atop
 * lib/agent-wp7.ts. Every scenario runs `convoz` (the real binary) against a real `convoz serve`; the owner's side of Crew
 * (Crew -> devtool -> Handoffs) is read from GET /api/handoffs?identity=devtool, the route that screen reads.
 */

// ---- Rule: The brief tells a new session everything it may see, in a fixed budget (M7) ----------------------------------

scenario("A fresh session gets the whole brief within 12 KB", { tag: ["@cli"] }, async ({ server, dataDir }) => {
  // Background
  const w = await briefWorld({ server, dataDir });

  // When a new session runs "convoz brief --as devtool"
  const res = await asDevtool(w, "fresh", ["brief"]);
  expect(res.code, res.stderr).toBe(0);
  const out = res.stdout;

  // Then the output is at most 12288 bytes
  expect(Buffer.byteLength(out)).toBeLessThanOrEqual(12288);

  // And it shows the identity, this session and machine "box-2"
  const who = sectionOf(out, "Who you are");
  expect(who).toContain("@devtool");
  expect(who).toMatch(/This session: .+ on machine box-2/);

  // And it shows the last handoff note, the unacked answer, the open ask, unread inbox counts by reason, the 3 conversations with unread
  // messages and the recent decision
  expect(sectionOf(out, "Last handoff")).toContain(NOTE_FIRST);
  expect(sectionOf(out, "Last handoff")).toContain("1 older note");
  expect(sectionOf(out, "Answers waiting")).toContain(`${w.asks.unacked} -> Yes, behind a flag`);
  expect(sectionOf(out, "Open asks")).toContain(w.asks.open);
  const inbox = sectionOf(out, "Inbox");
  expect(inbox).toContain("3 items waiting: mention 1, activity 2");
  const listed = listedConversations(out);
  expect([...listed.ids].sort()).toEqual([...w.unread].sort());
  expect(sectionOf(out, CONVERSATIONS)).toContain(`"Deploy alerts runbook": 1 unread`);
  expect(sectionOf(out, "Recent decisions")).toContain(`${w.asks.decision} -> SQLite FTS5`);

  // And the text "Secret merger plan" appears 0 times
  expect(occurrences(out, "Secret merger plan")).toBe(0);
});

scenario("The brief tells the agent to start watching its inbox at once", { tag: ["@cli"] }, async ({ server, dataDir }) => {
  const w = await briefWorld({ server, dataDir });

  // When a new session runs "convoz brief --as devtool"
  const res = await asDevtool(w, "fresh", ["brief"]);
  expect(res.code, res.stderr).toBe(0);

  // Then the section "Who you are" says to start "convoz watch --json"
  expect(sectionOf(res.stdout, "Who you are")).toContain("Start `convoz watch --json` now and keep it running");
});

scenario("The handoff and the asks come first and keep their budget", { tag: ["@cli"] }, async ({ server, dataDir }) => {
  // Given "devtool" has 60 conversations with unread messages
  const w = await briefWorld({ server, dataDir });
  await unreadConversations(w, 60);

  // When a new session runs "convoz brief --as devtool"
  const res = await asDevtool(w, "fresh", ["brief"]);
  expect(res.code, res.stderr).toBe(0);
  const out = res.stdout;

  // Then the last handoff note and every unacked answer and open ask are in the output
  expect(out).toContain(NOTE_FIRST);
  expect(out).toContain(w.asks.unacked);
  expect(out).toContain(w.asks.open);

  // And they come before the conversation section
  const at = (title: string): number => out.indexOf(`## ${title}`);
  expect(at("Last handoff")).toBeGreaterThan(-1);
  expect(at("Last handoff")).toBeLessThan(at(CONVERSATIONS));
  expect(at("Answers waiting")).toBeLessThan(at(CONVERSATIONS));
  expect(at("Open asks")).toBeLessThan(at(CONVERSATIONS));
});

scenario("Long sections show the top items and a count of the rest", { tag: ["@cli"] }, async ({ server, dataDir }) => {
  // Given "devtool" has 60 conversations with unread messages
  const w = await briefWorld({ server, dataDir });
  await unreadConversations(w, 60);

  // When a new session runs "convoz brief --as devtool"
  const res = await asDevtool(w, "fresh", ["brief"]);
  expect(res.code, res.stderr).toBe(0);

  // Then the conversation section lists the top 10 and ends with "and 50 more"
  const listed = listedConversations(res.stdout);
  expect(listed.ids).toHaveLength(10);
  expect(listed.last).toMatch(/^and 50 more/);
});

scenario("Conversations cut from a brief stay listed until the agent reads them", { tag: ["@cli"] }, async ({ server, dataDir }) => {
  // Given "devtool" has 60 conversations with unread messages
  const w = await briefWorld({ server, dataDir });
  const all = await unreadConversations(w, 60);

  // And session "s1" ran "convoz brief" and saw the top 10
  const s1 = await asDevtool(w, "s1", ["brief"]);
  expect(s1.code, s1.stderr).toBe(0);
  const top = listedConversations(s1.stdout).ids;
  expect(top).toHaveLength(10);

  // When session "s2" runs "convoz brief --page 2"
  const s2 = await asDevtool(w, "s2", ["brief", "--page", "2"]);
  expect(s2.code, s2.stderr).toBe(0);

  // Then the conversation section lists the next 10
  const next = listedConversations(s2.stdout);
  expect(next.ids).toHaveLength(10);
  expect(next.ids.filter((id) => top.includes(id))).toEqual([]);
  expect(next.last).toMatch(/^and 40 more/);
  const pages = [top, next.ids];
  for (let page = 3; page <= 6; page++) pages.push(listedConversations((await asDevtool(w, `p${page}`, ["brief", "--page", String(page)])).stdout).ids);
  expect([...pages.flat()].sort((a, b) => a - b)).toEqual([...all].sort((a, b) => a - b));

  // And a new "convoz brief" still lists the first 10
  const again = await asDevtool(w, "s3", ["brief"]);
  expect(listedConversations(again.stdout).ids).toEqual(top);

  // And after "convoz read" of one of them, the next brief no longer lists it
  const read = await asDevtool(w, "s4", ["read", String(top[3])]);
  expect(read.code, read.stderr).toBe(0);
  const after = listedConversations((await asDevtool(w, "s5", ["brief"])).stdout).ids;
  expect(after).not.toContain(top[3]);
  expect(after).toHaveLength(10);
  expect(after).toContain(next.ids[0]);
});

scenario("Overlapping sessions get the same brief", { tag: ["@cli"] }, async ({ server, dataDir }) => {
  // Given session "s1" of "devtool" is still live
  const w = await briefWorld({ server, dataDir });
  await unreadConversations(w, 12);
  const s1 = await startSession(w.box, "devtool", "s1");

  // When session "s2" starts and both run "convoz brief"
  const s2 = await startSession(w.box, "devtool", "s2");
  const a = await convoz(w.box, s1.sid, ["brief"]);
  const b = await convoz(w.box, s2.sid, ["brief"]);
  expect(a.code, a.stderr).toBe(0);
  expect(b.code, b.stderr).toBe(0);

  // Then both briefs list the same conversations with unread messages
  expect(listedConversations(a.stdout).ids).toHaveLength(10);
  expect(sectionOf(a.stdout, CONVERSATIONS)).toBe(sectionOf(b.stdout, CONVERSATIONS));
});

scenario("A brief changes nothing", { tag: ["@cli"] }, async ({ server, dataDir }) => {
  // Given the fixture and a session
  const w = await briefWorld({ server, dataDir });
  const s = await startSession(w.box, "devtool", "s1");
  const before = await inboxItems(w.box, s.sid, ["--peek"]);

  // When a session runs "convoz brief" twice
  const first = await convoz(w.box, s.sid, ["brief"]);
  const second = await convoz(w.box, s.sid, ["brief"]);
  expect(first.code, first.stderr).toBe(0);

  // Then both outputs are the same
  expect(second.stdout).toBe(first.stdout);

  // And "convoz inbox --peek" shows every item still ready
  const after = await inboxItems(w.box, s.sid, ["--peek"]);
  expect(before.length).toBeGreaterThan(0);
  expect(after.map((i) => [i.id, i.state, i.count])).toEqual(before.map((i) => [i.id, "ready", i.count]));
});

scenario("The brief reports items that expired unread", { tag: ["@cli"] }, async ({ server, dataDir }) => {
  // Given 2 items of "devtool" for conversation 41 expired unread on 2026-10-01
  const w = await briefWorld({ server, dataDir });
  const db = w.db();
  const at = Date.UTC(2026, 9, 1, 12);
  const insert = db.prepare(
    "INSERT INTO inbox_items (identity_id, reason, conversation_id, first_message_id, message_id, count, mention_count, source_seq, state, expired_reason, created_at, updated_at) VALUES (?, 'activity', ?, 1, 1, 1, 0, 1, 'expired', 'age', ?, ?)",
  );
  insert.run(idsByHandle(db).devtool!, w.conv, at - 1000, at);
  insert.run(idsByHandle(db).devtool!, w.conv, at - 500, at);
  db.close();

  // When a new session runs "convoz brief"
  const res = await asDevtool(w, "fresh", ["brief"]);
  expect(res.code, res.stderr).toBe(0);

  // Then the brief says "2 items expired unread since 2026-10-01" and names conversation 41
  const expired = sectionOf(res.stdout, "Expired unread");
  expect(expired).toContain("2 items expired unread since 2026-10-01");
  expect(expired).toContain(`conversation ${w.conv} "Ship search filters"`);
});

scenario("A larger brief is capped at 64 KB", { tag: ["@cli"] }, async ({ server, dataDir }) => {
  // Given the fixture with many conversations
  const w = await briefWorld({ server, dataDir });
  await unreadConversations(w, 60);

  // When a session runs "convoz brief --max-bytes 200000"
  const res = await asDevtool(w, "fresh", ["brief", "--max-bytes", "200000"]);
  expect(res.code, res.stderr).toBe(0);

  // Then the output is at most 65536 bytes
  expect(Buffer.byteLength(res.stdout)).toBeLessThanOrEqual(65536);
  const small = await asDevtool(w, "small", ["brief", "--max-bytes", "10", "--json"]);
  expect(JSON.parse(small.stdout).bytes).toBeLessThanOrEqual(4096);
});

scenario("The MCP brief tool returns the same brief", { tag: ["@mcp"] }, async ({ server, dataDir }) => {
  // Given the fixture
  const w = await briefWorld({ server, dataDir });
  const claude = "claude-TESTONLY-mcp-brief";
  const mcp = await McpClient.start(w.box, "devtool", claude);
  try {
    // When the MCP tool "brief" is called in "convoz mcp --as devtool"
    const result = await mcp.tool("brief");
    expect(result.isError).not.toBe(true);

    // Then the result has the same sections as "convoz brief"
    const cli = await w.box.run(["brief", "--as", "devtool", "--json"], { claude, timeoutMs: 20_000 });
    expect(cli.code, cli.stderr).toBe(0);
    const expected = JSON.parse(cli.stdout);
    expect(result.structuredContent.sections.map((s: { key: string }) => s.key)).toEqual(expected.sections.map((s: { key: string }) => s.key));
    expect(result.structuredContent.sections).toEqual(expected.sections);
    expect(result.content[0]!.text).toBe(expected.text);
  } finally {
    mcp.end();
    await mcp.exited;
  }
});

// ---- Rule: A handoff note carries context to the next session -------------------------------------------------------------

scenario("A handoff note is stored with the session and machine", { tag: ["@cli"] }, async ({ server, dataDir }) => {
  // Background
  const w = await briefWorld({ server, dataDir });

  // When session "s1" runs "convoz handoff 'Halfway through #412; tests 3 and 7 still flaky'"
  const note = "Halfway through #412; tests 3 and 7 still flaky, rerun with --retries 2";
  const s1 = await w.box.sessionStart("devtool", ["--label", "claude-code · repo"], { claude: "claude-TESTONLY-s1" });
  expect(s1.code, s1.stderr).toBe(0);
  const stored = await w.box.run(["handoff", "--as", "devtool", "--timeout", "10s", note], { claude: "claude-TESTONLY-s1", timeoutMs: 20_000 });
  expect(stored.code, stored.stderr).toBe(0);

  // Then the next "convoz brief" of "devtool" shows that note as the last handoff
  const next = await asDevtool(w, "s2", ["brief"]);
  expect(sectionOf(next.stdout, "Last handoff")).toContain(note);

  // And the owner sees the note in Crew -> devtool -> Handoffs with the session label and "box-2"
  const listed = await w.owner.client.get("/api/handoffs?identity=devtool");
  expect(listed.status, listed.text).toBe(200);
  const [newest] = listed.json().handoffs;
  expect(newest).toMatchObject({ body: note, session: "claude-code · repo", machine: "box-2" });
});

scenario("A handoff note over 4 KB is refused", { tag: ["@cli"] }, async ({ server, dataDir }) => {
  // Background
  const w = await briefWorld({ server, dataDir });
  const s = await startSession(w.box, "devtool", "s1");

  // When a session stores a handoff note of 4097 bytes
  const res = await w.box.run(["handoff", "--sid", s.sid, "--timeout", "10s", "-"], { stdin: "x".repeat(4097), timeoutMs: 20_000 });

  // Then the CLI exits 2 with a message naming the 4096-byte cap
  expect(res.code).toBe(2);
  expect(res.stderr).toContain("4096 bytes");
  const direct = await send(w.srv.target, "POST", "/api/handoffs", { json: { client_id: "c-over-4096-bytes", body: "x".repeat(4097) }, ...bearer(s.lease) });
  expect(direct.status).toBe(400);
  const whole = await send(w.srv.target, "POST", "/api/handoffs", { json: { client_id: "c-exactly-4096", body: "y".repeat(4096) }, ...bearer(s.lease) });
  expect(whole.status).toBe(201);
});

scenario("The last handoff note always fits the brief whole", { tag: ["@cli"] }, async ({ server, dataDir }) => {
  // Given the last handoff note of "devtool" is 4096 bytes of text in three languages
  const w = await briefWorld({ server, dataDir });
  const words = ["the build is green again, ", "сборка снова зелёная, ", "ビルドは再び成功しました。"];
  let note = "";
  for (let i = 0; Buffer.byteLength(note + words[i % 3]!) <= 4096; i++) note += words[i % 3];
  note += "x".repeat(4096 - Buffer.byteLength(note));
  expect(Buffer.byteLength(note)).toBe(4096);
  const s = await startSession(w.box, "devtool", "writer");
  const stored = await w.box.run(["handoff", "--sid", s.sid, "--timeout", "10s", "-"], { stdin: note, timeoutMs: 20_000 });
  expect(stored.code, stored.stderr).toBe(0);

  // And "devtool" has 60 conversations with unread messages
  await unreadConversations(w, 60);

  // When a new session runs "convoz brief"
  const res = await asDevtool(w, "fresh", ["brief"]);
  expect(res.code, res.stderr).toBe(0);

  // Then the note appears whole in the output
  expect(res.stdout).toContain(note);
  expect(Buffer.byteLength(res.stdout)).toBeLessThanOrEqual(12288);
  expect(listedConversations(res.stdout).ids).toHaveLength(10);
});

scenario("The 50 newest handoff notes are kept", { tag: ["@cli"] }, async ({ server, dataDir }) => {
  // Given "devtool" stored 50 handoff notes
  const w = await briefWorld({ server, dataDir });
  const s = await startSession(w.box, "devtool", "writer");
  for (let n = 1; n <= 50; n++) {
    const res = await send(w.srv.target, "POST", "/api/handoffs", { json: { client_id: `c-note-${String(n).padStart(4, "0")}`, body: `note ${n}` }, ...bearer(s.lease) });
    expect(res.status, res.text).toBe(201);
  }

  // When it stores one more
  const more = await convoz(w.box, s.sid, ["handoff", "note 51"]);
  expect(more.code, more.stderr).toBe(0);

  // Then "convoz handoff --list" shows 50 notes and the oldest is gone
  const listed = await convoz(w.box, s.sid, ["handoff", "--list", "--json"]);
  expect(listed.code, listed.stderr).toBe(0);
  const bodies: string[] = JSON.parse(listed.stdout).handoffs.map((h: { body: string }) => h.body);
  expect(bodies).toHaveLength(50);
  expect(bodies[0]).toBe("note 51");
  expect(bodies).not.toContain("First note: the flag name is search_chips");
  expect(bodies).not.toContain("note 1");
  expect(bodies).toContain("note 2");
});

scenario("A retried handoff makes one note", { tag: ["@cli"] }, async ({ server, dataDir }) => {
  // Given a fault proxy drops the response of the first "convoz handoff" request
  const w = await briefWorld({ server, dataDir });
  const direct = await startSession(w.box, "devtool", "writer");
  const proxy = await faultProxy(w.srv.target, { method: "POST", path: "/api/handoffs", nth: 1 });
  try {
    const via = await machineVia(proxy.url, w.box2.key, w.box, direct.sid);

    // When the CLI retries with the same client id
    const res = await via.run(["handoff", "--sid", direct.sid, "--timeout", "10s", "One careful note"], { timeoutMs: 40_000 });
    expect(res.code, res.stderr).toBe(0);
    const sent = proxy.entries("POST", "/api/handoffs");
    expect(sent.map((e) => e.dropped)).toEqual([true, false]);
    expect(sent[1]!.bodyHash).toBe(sent[0]!.bodyHash);

    // Then "convoz handoff --list" shows the note once
    const listed = await convoz(w.box, direct.sid, ["handoff", "--list", "--json"]);
    const bodies: string[] = JSON.parse(listed.stdout).handoffs.map((h: { body: string }) => h.body);
    expect(bodies.filter((b) => b === "One careful note")).toHaveLength(1);
  } finally {
    await proxy.close();
  }
});

// ---- Rule: An agent reads and searches only what it can see -----------------------------------------------------------------

scenario("An agent added later does not read earlier messages", { tag: ["@cli"] }, async ({ server, dataDir }) => {
  // Given conversation 41 had 20 messages before the owner added "devtool" with history "since now"
  const w = await briefWorld({ server, dataDir });
  const conv = await createConversation(w.owner, { participants: ["docs"], title: "Ship the rollout" });
  for (let n = 1; n <= 20; n++) await ownerSays(w.owner, conv, `earlier message ${n}`);
  const added = await ownerAdds(w.owner, conv, w.ids.devtool!, "since_now");
  expect(added.status, added.text).toBeLessThan(300);
  await ownerSays(w.owner, conv, "after the add 1");
  await ownerSays(w.owner, conv, "after the add 2");

  // When "devtool" runs "convoz read 41"
  const res = await asDevtool(w, "reader", ["read", String(conv), "--json"]);
  expect(res.code, res.stderr).toBe(0);

  // Then it sees only the messages from its add onward
  const bodies: string[] = JSON.parse(res.stdout).messages.map((m: { body: string }) => m.body);
  expect(bodies.filter((b) => b.startsWith("earlier message"))).toEqual([]);
  expect(bodies).toEqual(expect.arrayContaining(["after the add 1", "after the add 2"]));
  expect((await pageOf(w.owner, conv, "limit=100")).filter((m) => m.body.startsWith("earlier message"))).toHaveLength(20);
});

scenario("Agent search returns only conversations it can see, newest first", { tag: ["@cli"] }, async ({ server, dataDir }) => {
  // Given "Secret merger plan" and conversation 41 both contain the word "merger"
  const w = await briefWorld({ server, dataDir });
  await ownerSays(w.owner, w.conv, "the merger of the two indexes is done");
  await ownerSays(w.owner, w.conv, "second merger note for the index");
  await ownerSays(w.owner, w.secret, "merger terms attached");

  // When "devtool" runs "convoz search merger"
  const res = await asDevtool(w, "searcher", ["search", "--json", "merger"]);
  expect(res.code, res.stderr).toBe(0);

  // Then every result is from conversation 41
  const results: { message_id: number; conversation_id: number; created_at: number }[] = JSON.parse(res.stdout).results;
  expect(results.length).toBeGreaterThanOrEqual(2);
  expect(results.map((r) => r.conversation_id)).toEqual(results.map(() => w.conv));
  expect(occurrences(res.stdout, "Secret merger plan")).toBe(0);

  // And results are ordered newest first
  expect(results.map((r) => r.message_id)).toEqual([...results.map((r) => r.message_id)].sort((a, b) => b - a));
  expect(results.map((r) => r.created_at)).toEqual([...results.map((r) => r.created_at)].sort((a, b) => b - a));
});
