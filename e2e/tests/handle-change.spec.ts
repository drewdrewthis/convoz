import fs from "node:fs";
import { chatWorld, createConversation, messagesOf, ownerPost, ownerSays, startSession } from "../lib/chat.ts";
import { allow, bearer, clientId, HOUR, lease, loginMachine, mintSession, plainDb, signInBrowser, whoamiApi } from "../lib/machines.ts";
import { must, signIn, type Owner } from "../lib/owner.ts";
import { send, type Res } from "../lib/http.ts";
import { ask, decrypt, pushWorld, received, sleep, type PushWorld, type Shown } from "../lib/push-wp14.ts";
import { expect, scenario } from "../lib/scenario.ts";
import { installed } from "../lib/wp17.ts";

/*
 * crew.feature, rule "An agent's handle can change" (I-51), user-facing and contract bindings.
 * Owner (2026-10-18): "Handles I think can also change, that seems fine because there's an id, right?" Earlier: "the handle is never reused."
 * Asked whether an agent's own change needs approval, the owner chose "Change at once, no approval": "I think that's too defensive and
 * requires too much machinery?"
 *
 * Contract these bindings rely on:
 *   POST /api/me/handle (lease) {handle} -> 200 {identity:{id, handle, previous_handle, previous_until}}; 3 changes a day at most (429 + Retry-After)
 *   POST /api/identities/:id/handle (owner, no step-up) {handle} -> 200 {identity:{id, handle, previous_handle, previous_until}}
 *   GET /api/identities: previous_handles, handle_changed_at; a message: mentions [{as_written, identity_id, handle}]
 *   POST /api/sessions with a retired `as`: 201 + renamed {from, to, until} for 30 days, then 403 handle_renamed.
 *   Page: /crew/<handle> shows "Was @old", button "Change handle" opens the
 *   group "Change handle" with the textbox "New handle" and the button "Save".
 */

const DAY = 24 * HOUR;
const PLAIN = { CONVOZ_TEST_PLAINTEXT: "1" };

interface IdentityRow {
  id: number;
  handle: string;
  kind: string;
  previous_handles?: string[];
  handle_changed_at?: number;
}

async function identities(owner: Owner): Promise<IdentityRow[]> {
  return must(await owner.client.get("/api/identities"), "identities").json().identities as IdentityRow[];
}

async function idOf(owner: Owner, handle: string): Promise<number> {
  const row = (await identities(owner)).find((i) => i.handle === handle);
  if (!row) throw new Error(`no identity @${handle}`);
  return row.id;
}

/** The owner changes an agent's handle, the way Crew → the agent → "Change handle" does. */
const changeHandle = (owner: Owner, id: number, handle: string): Promise<Res> => owner.client.post(`/api/identities/${id}/handle`, { handle });

async function changed(owner: Owner, from: string, to: string): Promise<number> {
  const id = await idOf(owner, from);
  must(await changeHandle(owner, id, to), `change @${from} to @${to}`);
  return id;
}

/** An agent changes its own handle with its lease. */
const ownHandle = (srv: { target: Parameters<typeof send>[0] }, token: string, body: Record<string, unknown>): Promise<Res> =>
  send(srv.target, "POST", "/api/me/handle", { json: body, ...bearer(token) });

const errorOf = (res: Res): { code: string; message: string; field?: string } => res.json().error;

async function serverNow(owner: Owner): Promise<number> {
  return must(await owner.client.get("/api/now"), "now").json().now as number;
}

async function auditRows(owner: Owner): Promise<{ action: string; target_id: number; session_id: number | null; detail?: Record<string, unknown> }[]> {
  return must(await owner.client.get("/api/admin/audit"), "audit").json().audit;
}

// ---- user-facing: specs/features/crew.feature -------------------------------------------------------------------------------------

scenario("An agent changes its own handle at once", { tag: ["@cli", "@browser"] }, async ({ server, page, context }) => {
  // Given "devtool" is in the conversation "Ship search filters"
  const w = await chatWorld(server, { agents: ["devtool"] });
  const conv = await createConversation(w.owner, { participants: ["devtool"], title: "Ship search filters" });
  const s = await startSession(w.box, "devtool", "handle-ask");
  const before = await serverNow(w.owner);

  // When "convoz profile --set handle=builder" runs as "devtool"
  const done = await w.box.run(["profile", "--sid", s.sid, "--set", "handle=builder"], { timeoutMs: 20_000 });

  // Then the CLI prints "You are now @builder. Old @devtool works until" followed by the date 30 days on, and exits 0
  expect(done.code, done.stderr).toBe(0);
  const day = (ms: number) => new Date(ms + 30 * DAY).toISOString().slice(0, 10);
  const dates = new Set([day(before), day(await serverNow(w.owner))]);
  const printed = /^You are now @builder\. Old @devtool works until (\d{4}-\d{2}-\d{2})\.\n$/.exec(done.stdout);
  expect(printed, done.stdout).not.toBeNull();
  expect(dates.has(printed![1]!), `${printed![1]} in ${[...dates]}`).toBe(true);

  // And the owner sees no Now card about it
  await signInBrowser(w.srv, w.owner, page, context);
  await installed(page); // a cold page carries /api/now inline, and the wait below would never end
  const nowLoaded = page.waitForResponse((r) => r.url().endsWith("/api/now"));
  await page.reload();
  await nowLoaded;
  await expect(page.getByRole("article")).toHaveCount(0);
  expect(must(await w.owner.client.get("/api/now"), "now").json().handle_requests).toBeUndefined();

  // And Crew shows "builder" with the line "Was @devtool"
  await page.goto(`${w.srv.origin}/crew/builder`);
  await expect(page.getByRole("heading", { level: 2 })).toContainText("@builder");
  await expect(page.getByText("Was @devtool", { exact: true })).toBeVisible();

  // And "Ship search filters" shows the line "@devtool is now @builder"
  await page.goto(`${w.srv.origin}/chats/${conv}`);
  await expect(page.getByText("@devtool is now @builder", { exact: true })).toBeVisible();

  // And "convoz whoami" in the same session shows identity "builder"
  const who = await w.box.whoami(["--sid", s.sid]);
  expect(who.code, who.stderr).toBe(0);
  expect(who.stdout).toContain("identity: builder");
  const file = JSON.parse(fs.readFileSync(w.box.sessionPath(s.sid), "utf8")) as { identity: string; as: string; identity_id: number };
  expect([file.identity, file.as]).toEqual(["builder", "devtool"]);
});

scenario("The owner changes an agent's handle in Crew", { tag: ["@browser"] }, async ({ server, page, context }) => {
  // Given "devtool" is in the conversation "Ship search filters"
  const w = await chatWorld(server, { agents: ["devtool"] });
  const conv = await createConversation(w.owner, { participants: ["devtool"], title: "Ship search filters" });
  await signInBrowser(w.srv, w.owner, page, context);

  // When the owner opens the profile of "devtool" in Crew, taps "Change handle", types "builder" and taps Save
  await page.goto(`${w.srv.origin}/crew/devtool`);
  await page.getByRole("button", { name: "Change handle", exact: true }).click();
  const form = page.getByRole("group", { name: "Change handle" });
  await form.getByRole("textbox", { name: "New handle" }).fill("builder");
  await form.getByRole("button", { name: "Save", exact: true }).click();

  // Then no passkey prompt opens
  await expect(page.getByRole("dialog")).toHaveCount(0);

  // And the profile shows "@builder" and "Was @devtool"
  await expect(page.getByRole("heading", { level: 2 })).toContainText("@builder");
  await expect(page.getByText("Was @devtool", { exact: true })).toBeVisible();
  expect((await identities(w.owner)).find((i) => i.handle === "builder")?.previous_handles).toEqual(["devtool"]);

  // And "Ship search filters" shows the line "@devtool is now @builder"
  await page.goto(`${w.srv.origin}/chats/${conv}`);
  await expect(page.getByText("@devtool is now @builder", { exact: true })).toBeVisible();
});

scenario("A message to the old handle still reaches the agent", { tag: ["@cli"] }, async ({ server }) => {
  // Given the owner changed the handle of "devtool" to "builder"
  const w = await chatWorld(server, { agents: ["devtool"] });
  await changed(w.owner, "devtool", "builder");

  // When the owner writes "@devtool can you look at the build?" in a new conversation
  const conv = await createConversation(w.owner, { participants: [], title: "Build" });
  const msg = await ownerSays(w.owner, conv, "@devtool can you look at the build?");

  // Then "builder" is a participant of that conversation
  const row = (must(await w.owner.client.get("/api/conversations"), "rail").json().conversations as { id: number; participants: { handle: string }[] }[]).find((c) => c.id === conv);
  expect(row?.participants.map((p) => p.handle)).toContain("builder");

  // And "convoz inbox" as "builder" lists the mention of that message
  const s = await startSession(w.box, "builder", "handle-inbox");
  const res = await w.box.run(["inbox", "--sid", s.sid, "--json", "--peek", "--timeout", "10s"], { timeoutMs: 20_000 });
  expect(res.code, res.stderr).toBe(0);
  const items = JSON.parse(res.stdout).items as { reason: string; message: { id: number } }[];
  expect(items.some((i) => i.reason === "mention" && i.message.id === msg)).toBe(true);
});

scenario("The old handle works for 30 days with a warning, then is refused with the new one named", { tag: ["@cli"] }, async ({ server, testApi }) => {
  // Given a session of "devtool" on "box-2" and then the owner changed the handle of "devtool" to "builder"
  const w = await chatWorld(server, { agents: ["devtool"] });
  const claude = `claude-TESTONLY-${clientId().slice(-10)}`;
  expect((await w.box.whoami([], { as: "devtool", claude })).code).toBe(0);
  await changed(w.owner, "devtool", "builder");

  // When "convoz whoami" runs with CONVOZ_AS=devtool in that session
  const warned = await w.box.whoami([], { as: "devtool", claude });

  // Then it shows identity "builder" and the warning names "@builder"
  expect(warned.code, warned.stderr).toBe(0);
  expect(warned.stdout).toContain("identity: builder");
  expect(warned.stderr).toMatch(/^convoz: @devtool is now @builder\. Use --as builder: @devtool stops working on \d{4}-\d{2}-\d{2}\.\n$/);

  // When 30 days and 1 second pass
  await testApi(w.srv).advanceClock(30 * DAY + 1_000);

  // Then "convoz whoami" with CONVOZ_AS=devtool exits 3 with an error that names "@builder"
  for (const o of [{ as: "devtool", claude }, { as: "devtool" }]) {
    const late = await w.box.whoami([], o);
    expect(late.code, late.stderr).toBe(3);
    expect(late.stderr).toContain("@devtool is now @builder. Use --as builder.");
  }

  // And "convoz whoami" with CONVOZ_AS=builder works
  const ok = await w.box.whoami([], { as: "builder", claude });
  expect(ok.code, ok.stderr).toBe(0);
  expect(ok.stdout).toContain("identity: builder");
  expect(ok.stderr).toBe("");
});

scenario("An old handle is never used again, and a handle changes 3 times a day at most", { tag: ["@cli"] }, async ({ server }) => {
  // Given "box-2" also runs "docs", and the owner changed the handle of "devtool" to "builder"
  const w = await chatWorld(server, { agents: ["devtool", "docs"] });
  await changed(w.owner, "devtool", "builder");

  // When "convoz profile --set handle=devtool" runs as "docs"
  const reused = await w.box.run(["profile", "--set", "handle=devtool"], { as: "docs", timeoutMs: 20_000 });

  // Then the CLI exits 4 and says the handle is taken or was used before
  expect(reused.code, reused.stderr).toBe(4);
  expect(reused.stderr).toMatch(/taken or was used before/);

  // When "convoz profile --set handle=builder-2" and then "handle=builder-3" run as the agent
  const second = await w.box.run(["profile", "--set", "handle=builder-2"], { as: "builder", timeoutMs: 20_000 });
  const third = await w.box.run(["profile", "--set", "handle=builder-3"], { as: "builder-2", timeoutMs: 20_000 });

  // Then both succeed
  expect([second.code, third.code], `${second.stderr} | ${third.stderr}`).toEqual([0, 0]);

  // When "convoz profile --set handle=builder-4" runs as the agent
  const fourth = await w.box.run(["profile", "--set", "handle=builder-4"], { as: "builder-3", timeoutMs: 20_000 });

  // Then the CLI exits 5 and says a handle changes 3 times a day at most
  expect(fourth.code, fourth.stderr).toBe(5);
  expect(fourth.stderr).toMatch(/A handle changes 3 times a day at most/);
});

// ---- contracts: specs/contracts/crew.feature ----------------------------------------------------------------------------------------

scenario("A handle change retires the old handle at once and tells every conversation", { tag: ["@api"] }, async ({ server, dataDir }) => {
  // Given "devtool" is in conversations 41 and 52
  const w = await chatWorld(server, { agents: ["devtool"], env: PLAIN });
  const convs = [await createConversation(w.owner, { participants: ["devtool"] }), await createConversation(w.owner, { participants: ["devtool"] })];
  const id = await idOf(w.owner, "devtool");
  const before = await serverNow(w.owner);

  // When the owner sends POST /api/identities/:id/handle with {"handle": "builder"} and no step-up
  const res = await changeHandle(w.owner, id, "builder");
  const after = await serverNow(w.owner);

  // Then the server answers 200 with the handle "builder" and the previous handle "devtool"
  expect(res.status, res.text).toBe(200);
  expect(res.json().identity).toMatchObject({ id, handle: "builder", previous_handle: "devtool" });

  // And GET /api/identities lists "builder" under the same id with previous_handles ["devtool"]
  const row = (await identities(w.owner)).find((i) => i.id === id)!;
  expect([row.handle, row.previous_handles]).toEqual(["builder", ["devtool"]]);

  // And retired_handles holds "devtool" for that id, retired at the time of the change
  const db = plainDb(dataDir);
  try {
    const retired = db.prepare("SELECT identity_id, retired_at FROM retired_handles WHERE handle = 'devtool'").all() as { identity_id: number; retired_at: number }[];
    const at = (db.prepare("SELECT handle_changed_at AS at FROM identities WHERE id = ?").get(id) as { at: number }).at;
    expect(retired).toEqual([{ identity_id: id, retired_at: at }]);
    expect(at).toBeGreaterThanOrEqual(before);
    expect(at).toBeLessThanOrEqual(after);
  } finally {
    db.close();
  }
  expect(row.handle_changed_at).toBeGreaterThanOrEqual(before);

  // And conversations 41 and 52 each end with the system line "@devtool is now @builder"
  for (const conv of convs) {
    const last = (await messagesOf(w.owner, conv)).at(-1) as unknown as { kind?: string; text?: string; system?: { t: string; from?: string; to?: string } };
    expect([last.kind, last.text, last.system?.t, last.system?.from, last.system?.to]).toEqual(["system", "@devtool is now @builder", "member.renamed", "devtool", "builder"]);
  }

  // And the audit row "identity.handle_changed" has the detail {"from": "devtool", "to": "builder"}
  const audit = (await auditRows(w.owner)).filter((a) => a.action === "identity.handle_changed");
  expect(audit.map((a) => [a.target_id, a.detail])).toEqual([[id, { from: "devtool", to: "builder" }]]);
});

scenario("A new handle passes every rule of a new one", { tag: ["@api"] }, async ({ server }) => {
  // Given the agents "docs" and "release-bot" exist and "docs" changed its handle to "writer"
  const w = await chatWorld(server, { agents: ["devtool", "docs", "release-bot"] });
  await changed(w.owner, "docs", "writer");
  const id = await idOf(w.owner, "devtool");

  const rows: [string, number, string][] = [
    ["admin", 400, "invalid_request"],
    ["Dev_Tool!", 400, "invalid_request"],
    ["writer", 409, "handle_taken"],
    ["docs", 409, "handle_taken"],
    ["re1ease-bot", 400, "invalid_request"],
  ];
  for (const [handle, status, code] of rows) {
    // When the owner changes the handle of "devtool" to <handle>
    const res = await changeHandle(w.owner, id, handle);

    // Then the server answers <status> with the code <code>
    expect(res.status, `${handle}: ${res.text}`).toBe(status);
    expect(errorOf(res).code, handle).toBe(code);
    expect(errorOf(res).field, handle).toBe("handle");
  }
  expect((await identities(w.owner)).find((i) => i.id === id)?.handle).toBe("devtool");
});

scenario("An agent changes its own handle with its lease, at once", { tag: ["@api"] }, async ({ server }) => {
  // Given "devtool" is in conversations 41 and 52
  const w = await chatWorld(server, { agents: ["devtool"] });
  const convs = [await createConversation(w.owner, { participants: ["devtool"] }), await createConversation(w.owner, { participants: ["devtool"] })];
  const id = await idOf(w.owner, "devtool");
  const token = await lease(w.srv, w.box2.key, { as: "devtool" });
  const session = must(await whoamiApi(w.srv, token), "whoami").json().session.id as number;
  const before = await serverNow(w.owner);

  // When the "devtool" session sends POST /api/me/handle with {"handle": "builder"}
  const res = await ownHandle(w.srv, token, { handle: "builder" });
  const after = await serverNow(w.owner);

  // Then the server answers 200 with the handle "builder", the previous handle "devtool" and a previous_until 30 days on
  expect(res.status, res.text).toBe(200);
  expect(res.json().identity).toMatchObject({ id, handle: "builder", previous_handle: "devtool" });
  expect(res.json().identity.previous_until).toBeGreaterThanOrEqual(before + 30 * DAY);
  expect(res.json().identity.previous_until).toBeLessThanOrEqual(after + 30 * DAY);

  // And GET /api/now lists no handle requests
  expect(must(await w.owner.client.get("/api/now"), "now").json().handle_requests).toBeUndefined();

  // And conversations 41 and 52 each end with the system line "@devtool is now @builder"
  for (const conv of convs) {
    const last = (await messagesOf(w.owner, conv)).at(-1) as unknown as { kind?: string; text?: string };
    expect([last.kind, last.text]).toEqual(["system", "@devtool is now @builder"]);
  }

  // And the audit has "identity.handle_changed" with the session of "devtool" and both handles
  const changedRow = (await auditRows(w.owner)).find((a) => a.action === "identity.handle_changed");
  expect(changedRow).toMatchObject({ session_id: session, detail: { from: "devtool", to: "builder" } });

  // When a machine key and a caller with no credential each send POST /api/me/handle
  const got = [
    (await send(w.srv.target, "POST", "/api/me/handle", { json: { handle: "other" }, ...bearer(w.box2.key) })).status,
    (await send(w.srv.target, "POST", "/api/me/handle", { json: { handle: "other" } })).status,
  ];

  // Then the server answers 401 or 403 both times
  expect(got.every((status) => status === 401 || status === 403), JSON.stringify(got)).toBe(true);
});

scenario("Two changes at once: both apply in turn, and a post during them reaches the same agent", { tag: ["@api"] }, async ({ server, dataDir }) => {
  const w = await chatWorld(server, { agents: ["devtool"], env: PLAIN });
  const id = await idOf(w.owner, "devtool");
  const token = await lease(w.srv, w.box2.key, { as: "devtool" });
  const conv = await createConversation(w.owner, { participants: [] });

  // When "devtool" changes its own handle to "maker", the owner changes it to "builder", and the owner posts "@devtool status?" all at once
  const [own, direct, post] = await Promise.all([
    ownHandle(w.srv, token, { handle: "maker" }),
    changeHandle(w.owner, id, "builder"),
    ownerPost(w.owner, conv, "@devtool status?"),
  ]);

  // Then both changes answer 200, one after the other
  expect([own.status, direct.status], `${own.text} | ${direct.text}`).toEqual([200, 200]);

  // And the agent has the handle of the change that came last, and "devtool" and the handle between are each retired once
  const row = (await identities(w.owner)).find((i) => i.id === id)!;
  const last = own.json().identity.previous_handle === "devtool" ? "builder" : "maker";
  const first = last === "builder" ? "maker" : "builder";
  expect([row.handle, [...(row.previous_handles ?? [])].sort()]).toEqual([last, ["devtool", first].sort()]);

  // And the post records a mention of the agent's id
  expect(post.status, post.text).toBe(201);
  const db = plainDb(dataDir);
  try {
    const mentions = db.prepare("SELECT identity_id FROM mentions WHERE message_id = ?").all(post.json().id) as { identity_id: number }[];
    expect(mentions).toEqual([{ identity_id: id }]);
    expect((db.prepare("SELECT COUNT(*) AS n FROM retired_handles WHERE handle = 'devtool'").get() as { n: number }).n).toBe(1);
  } finally {
    db.close();
  }
});

scenario("The owner renames an agent back to its own old handle, and nobody else may take a retired handle", { tag: ["@api"] }, async ({ server, dataDir }) => {
  // Given the agents "devtool" and "docs" exist and the owner changed the handle of "devtool" to "builder"
  const w = await chatWorld(server, { agents: ["devtool", "docs"], env: PLAIN });
  const id = await changed(w.owner, "devtool", "builder");

  // When the owner changes the handle of "builder" back to "devtool" from Crew
  const back = await changeHandle(w.owner, id, "devtool");

  // Then the server answers 200 with the handle "devtool" and the previous handle "builder"
  expect(back.status, back.text).toBe(200);
  expect(back.json().identity).toMatchObject({ id, handle: "devtool", previous_handle: "builder" });

  // And retired_handles no longer holds "devtool" and holds "builder" for that id
  const db = plainDb(dataDir);
  try {
    expect(db.prepare("SELECT identity_id FROM retired_handles WHERE handle = 'devtool'").all()).toEqual([]);
    expect(db.prepare("SELECT identity_id FROM retired_handles WHERE handle = 'builder'").all()).toEqual([{ identity_id: id }]);
  } finally {
    db.close();
  }

  // And "docs" asking for "devtool" or for "builder" gets 409 with the code "handle_taken"
  const docs = await idOf(w.owner, "docs");
  for (const handle of ["devtool", "builder"]) {
    const refused = await changeHandle(w.owner, docs, handle);
    expect(refused.status, `${handle}: ${refused.text}`).toBe(409);
    expect(errorOf(refused).code, handle).toBe("handle_taken");
  }

  // And docs asking with its own lease gets the same answer
  const token = await lease(w.srv, w.box2.key, { as: "docs" });
  const own = await ownHandle(w.srv, token, { handle: "builder" });
  expect([own.status, errorOf(own).code]).toEqual([409, "handle_taken"]);
});

scenario("A post to the old handle records the mention and names the current handle", { tag: ["@api"] }, async ({ server }) => {
  // Given the owner changed the handle of "devtool" to "builder"
  const w = await chatWorld(server, { agents: ["devtool"] });
  const id = await changed(w.owner, "devtool", "builder");

  // When the owner posts "@devtool look" in a conversation without "builder"
  const conv = await createConversation(w.owner, { participants: [] });
  const msg = await ownerSays(w.owner, conv, "@devtool look");

  // Then "builder" is an active participant of that conversation and its inbox holds the mention
  const token = await lease(w.srv, w.box2.key, { as: "builder" });
  const inbox = must(await send(w.srv.target, "GET", "/api/inbox?peek=1", bearer(token)), "inbox").json().items as { reason: string; message: { id: number } }[];
  expect(inbox.filter((i) => i.reason === "mention").map((i) => i.message.id)).toEqual([msg]);
  const page = must(await send(w.srv.target, "GET", `/api/conversations/${conv}/messages`, bearer(token)), "builder reads").json().messages as { id: number }[];
  expect(page.map((m) => m.id)).toContain(msg);

  // And the message lists the mention {"as_written": "devtool", "identity_id": <the id>, "handle": "builder"}
  const m = (await messagesOf(w.owner, conv)).find((x) => x.id === msg) as unknown as { mentions?: unknown };
  expect(m.mentions).toEqual([{ as_written: "devtool", identity_id: id, handle: "builder" }]);
});

scenario("A handle change keeps the machines that may act as the agent", { tag: ["@api"] }, async ({ server }) => {
  // Given "box-2" allows "dev-*" and "laptop-1" allows "ops-*"
  const w = await chatWorld(server, { agents: ["devtool", "dev-search"], allowed: allow("devtool", "dev-*") });
  await loginMachine(w.srv, w.owner, "laptop-1", allow("ops-*"));

  // And "dev-search" has a live session on "box-2"
  const live = await lease(w.srv, w.box2.key, { as: "dev-search" });

  // When the owner changes the handle of "dev-search" to "searcher"
  const id = await changed(w.owner, "dev-search", "searcher");

  // Then the live session still answers 200 and "box-2" starts a new session as "searcher"
  const me = await whoamiApi(w.srv, live);
  expect(me.status, me.text).toBe(200);
  expect(me.json().identity).toMatchObject({ id, handle: "searcher" });
  expect((await mintSession(w.srv, w.box2.key, { as: "searcher" })).status).toBe(201);

  // And changing the handle of "devtool" to "ops-tool" answers 400 naming "handle"
  const widened = await changeHandle(w.owner, await idOf(w.owner, "devtool"), "ops-tool");
  expect(widened.status, widened.text).toBe(400);
  expect(errorOf(widened).field).toBe("handle");
});

scenario("The change limit and the old handle's 30 days run on the server clock", { tag: ["@api"] }, async ({ server, testApi }) => {
  // Given the owner changed the handle of "devtool" to "builder", then to "builder-2" and to "builder-3"
  const w = await chatWorld(server, { agents: ["devtool"] });
  const id = await changed(w.owner, "devtool", "builder");
  must(await changeHandle(w.owner, id, "builder-2"), "second change");
  must(await changeHandle(w.owner, id, "builder-3"), "third change");

  // When the owner changes it again
  const again = await changeHandle(w.owner, id, "builder-4");

  // Then the server answers 429 with a Retry-After of about 24 hours
  expect(again.status, again.text).toBe(429);
  expect(Math.abs(Number(again.headers["retry-after"]) - DAY / 1000)).toBeLessThan(120);

  // And "box-2" asking for a lease as "devtool" answers 201 with renamed from "devtool" to "builder-3"
  const graced = await mintSession(w.srv, w.box2.key, { as: "devtool" });
  expect(graced.status, graced.text).toBe(201);
  expect(graced.json().renamed).toMatchObject({ from: "devtool", to: "builder-3" });
  expect(graced.json().session).toMatchObject({ identity: "builder-3", identity_id: id });

  // When the test clock moves forward 30 days and 1 second
  await testApi(w.srv).advanceClock(30 * DAY + 1_000);

  // Then asking for a lease as "devtool" answers 403 with the code "handle_renamed" and a message that names "@builder-3"
  const late = await mintSession(w.srv, w.box2.key, { as: "devtool" });
  expect(late.status, late.text).toBe(403);
  expect(errorOf(late).code).toBe("handle_renamed");
  expect(errorOf(late).message).toContain("@builder-3");

  // And the owner can change the handle again
  must(await signIn(w.owner.client, w.owner.soft), "sign in again after 30 days");
  expect((await changeHandle(w.owner, id, "builder-4")).status).toBe(200);
});

/** Run an action and return the one push it causes. */
async function onePush(w: PushWorld, action: () => Promise<unknown>): Promise<Shown> {
  const before = (await received(w.srv)).length;
  await action();
  await expect.poll(async () => (await received(w.srv)).length, { timeout: 15_000 }).toBeGreaterThan(before);
  await sleep(800);
  const now = await received(w.srv);
  expect(now.length).toBe(before + 1);
  return decrypt(w.sub, now[before]!);
}

scenario("A push says who an agent was for 7 days", { tag: ["@api"] }, async ({ server, dataDir, testApi }, info) => {
  info.setTimeout(60_000);
  // Given the owner's browser is subscribed to pushes and the owner changed the handle of "devtool" to "builder"
  const w = await pushWorld(server, dataDir);
  await changed(w.owner, "devtool", "builder");

  // When "builder" asks a question
  const first = await onePush(w, () => ask(w, { question: "Ship it?" }));

  // Then the push title names "Dev Tool @builder (was @devtool)"
  expect(first.title).toContain("Dev Tool @builder (was @devtool)");

  // When the test clock moves forward 7 days and "builder" asks again
  await testApi(w.srv).advanceClock(7 * DAY + 1_000);
  const fresh = await lease(w.srv, w.box.key, { as: "builder" });
  const later = await onePush(w, () => ask(w, { question: "Ship it now?", lease: fresh }));

  // Then the push title names "Dev Tool @builder" and not "was"
  expect(later.title).toContain("Dev Tool @builder");
  expect(later.title).not.toContain("was");
});

scenario("The schema refuses a human's change, a reused handle and a change without its time", { tag: ["@api"] }, async ({ server, dataDir }) => {
  // Given the owner changed the handle of "devtool" to "builder"
  const w = await chatWorld(server, { agents: ["devtool", "docs"], env: PLAIN });
  const id = await changed(w.owner, "devtool", "builder");
  const docs = await idOf(w.owner, "docs");
  const owner = must(await w.owner.client.get("/api/me"), "me").json().identity.id as number;

  // When a second connection to the data file tries to change the owner's handle, to give "docs" the handle "devtool", and to change "builder" with no new time
  const db = plainDb(dataDir);
  try {
    const at = (db.prepare("SELECT handle_changed_at AS at FROM identities WHERE id = ?").get(id) as { at: number }).at;
    const writes: [string, RegExp][] = [
      [`UPDATE identities SET handle = 'drew-2', handle_changed_at = ${at} WHERE id = ${owner}`, /handle is immutable/],
      [`UPDATE identities SET handle = 'devtool', handle_changed_at = ${at} WHERE id = ${docs}`, /handle was used before/],
      [`UPDATE identities SET handle = 'builder-2', handle_changed_at = ${at} WHERE id = ${id}`, /needs its time/],
      [`UPDATE identities SET handle = 'builder-3' WHERE id = ${id}`, /needs its time/],
    ];

    // Then the schema refuses each write
    for (const [sql, why] of writes) expect(() => db.exec(sql), sql).toThrow(why);
    expect((db.prepare("SELECT handle FROM identities WHERE id = ?").get(id) as { handle: string }).handle).toBe("builder");
  } finally {
    db.close();
  }

  // And the owner's own handle cannot be changed through POST /api/identities/:id/handle
  const own = await changeHandle(w.owner, owner, "drew-2");
  expect(own.status, own.text).toBe(400);
  expect(must(await w.owner.client.get("/api/me"), "me").json().identity.handle).toBe("drew");
});
