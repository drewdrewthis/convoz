import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { McpClient, machineVia } from "../lib/agent-wp7.ts";
import { chatWorld, convoz, createConversation, messagesOf, ownerSays, startSession } from "../lib/chat.ts";
import { send } from "../lib/http.ts";
import { CliMachine } from "../lib/cli.ts";
import { forwarder, inboxWorld } from "../lib/left.ts";
import { bearer } from "../lib/machines.ts";
import { bootstrapOwner, must } from "../lib/owner.ts";
import { postWith, uploadWhole } from "../lib/uploads-wp10.ts";
import { expect, scenario } from "../lib/scenario.ts";

// Bindings of contracts/cli-mcp.feature that the agent-surface work package left open. "Status updates show in Crew" (features/cli-mcp)
// belongs to the Crew work package.

const patchProfile = (srv: Parameters<typeof send>[0], lease: string, body: unknown) => send(srv, "PATCH", "/api/me/profile", { json: body, ...bearer(lease) });

// ---- MCP ----------------------------------------------------------------------------------------------------------

scenario("No MCP tool result contains a secret", { tag: ["@mcp"] }, async ({ server }) => {
  const { w, conv } = await inboxWorld(server);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "convoz-mcp-"));
  const appFile = path.join(dir, "app.json");
  fs.writeFileSync(appFile, JSON.stringify({ v: 1, type: "code", title: "Hello", fallback: "Hello", props: { mode: "code", text: "hello" } }));
  const root = await ownerSays(w.owner, conv, "@devtool please look");
  const mcp = await McpClient.start(w.box, "devtool", "claude-TESTONLY-mcp-secrets");
  try {
    // When every MCP tool is called once with valid input
    const claimed = await mcp.tool("claim", { n: 1 });
    const item = (claimed.structuredContent?.items ?? JSON.parse(claimed.content[0]?.text ?? "{}").items ?? [])[0] as { id: number; claim_token: string } | undefined;
    const valid: Record<string, Record<string, unknown>> = {
      whoami: {},
      brief: {},
      inbox: { peek: true },
      claim: { n: 1 },
      ack: { items: [item ? `${item.id}:${item.claim_token}` : "1:00000000000000000000000000000000"] },
      read: { conversation: conv },
      search: { query: "please" },
      post: { conversation: conv, text: "Posted through MCP" },
      reply: { conversation: conv, message: root, text: "Replied through MCP" },
      ask: { conversation: conv, question: "Ship it?", recommended: { label: "Ship", why: "Green" }, alternatives: [{ label: "Wait", why: "One more check" }] },
      status: { state: "working", doing: "Reading", next: "Posting" },
      handoff: { note: "A note for the next session" },
      profile: { display_name: "Devtool bot" },
      app_validate: { path: appFile },
      app_build: { dir },
    };
    const tools = await mcp.listTools();
    expect(tools.map((t) => t.name).sort(), "every tool has valid input in this scenario").toEqual(expect.arrayContaining(Object.keys(valid).sort()));
    const results: Record<string, string> = {};
    for (const tool of tools) {
      const args = valid[tool.name] ?? Object.fromEntries(((tool.inputSchema?.required ?? []) as string[]).map((k) => [k, "x"])); // a tool added later: filled from its own schema
      results[tool.name] = JSON.stringify(await mcp.tool(tool.name, args));
    }

    // Then no result contains "cvz_m_", "cvz_s_" or "cvz_c_"
    for (const [name, text] of Object.entries(results)) {
      expect({ tool: name, secret: /cvz_[msc]_/.test(text) }).toEqual({ tool: name, secret: false });
    }
    expect(Object.keys(results).length).toBeGreaterThanOrEqual(15);
  } finally {
    mcp.end();
  }
});

// ---- retries ------------------------------------------------------------------------------------------------------

scenario("A client error is not retried", { tag: ["@cli"] }, async ({ server }) => {
  const { w, s1 } = await inboxWorld(server);
  const proxy = await forwarder(w.srv.target);
  try {
    const via = await machineVia(proxy.url, w.box2.key, w.box, s1.sid);

    // When "convoz post 999 hello" runs against a conversation that does not exist
    const res = await convoz(via, s1.sid, ["post", "999", "hello"]);

    // Then the proxy log shows 1 request
    expect(proxy.entries("POST", "/api/conversations/999/messages").map((e) => e.status)).toHaveLength(1);
    expect(proxy.entries("POST", "/api/conversations/999/messages")[0]!.status).toBeGreaterThanOrEqual(400);

    // And the CLI exits 3
    expect(res.code, res.stderr).toBe(3);
  } finally {
    await proxy.close();
  }
});

scenario("A rate limit is retried after Retry-After", { tag: ["@cli"] }, async ({ server }) => {
  const { w, conv, s1 } = await inboxWorld(server);
  const route = `/api/conversations/${conv}/messages`;

  // Given the server answers the first post with 429 and "Retry-After: 2"
  const proxy = await forwarder(w.srv.target, { method: "POST", path: route, status: 429, headers: { "Retry-After": "2" }, times: 1 });
  try {
    const via = await machineVia(proxy.url, w.box2.key, w.box, s1.sid);

    // When "convoz post 41 hello" runs
    const res = await convoz(via, s1.sid, ["post", String(conv), "hello"]);

    // Then the second request is sent no sooner than 2 seconds later
    const posts = proxy.entries("POST", route);
    expect(posts.map((e) => e.status)).toEqual([429, 201]);
    expect(posts[1]!.at - posts[0]!.at).toBeGreaterThanOrEqual(2000);

    // And the CLI exits 0
    expect(res.code, res.stderr).toBe(0);
    expect((await messagesOf(w.owner, conv)).filter((m) => m.body === "hello")).toHaveLength(1);
  } finally {
    await proxy.close();
  }
});

// ---- the agent's own profile --------------------------------------------------------------------------------------

scenario("Profile changes outside the allowed fields are refused", { tag: ["@api"] }, async ({ server }) => {
  const { w, s1 } = await inboxWorld(server);
  const rows: [string, unknown, number][] = [
    ['{"handle": "devtool2"}', { handle: "devtool2" }, 400],
    ['{"mood": "happy"}', { mood: "happy" }, 400],
    ["{\"capabilities\": 21 short strings}", { capabilities: Array.from({ length: 21 }, (_, i) => `c${i}`) }, 400],
  ];
  for (const [shown, body, status] of rows) {
    // When the "devtool" session sends PATCH /api/me/profile with <body>
    const res = await patchProfile(w.srv.target, s1.lease, body);

    // Then the server answers <status>
    expect([shown, res.status]).toEqual([shown, status]);
  }
  const profile = must(await send(w.srv.target, "GET", "/api/me", bearer(s1.lease)), "who am I", 200).json();
  expect(JSON.stringify(profile)).not.toContain("devtool2");
});

scenario("An agent cannot change another identity's profile", { tag: ["@api"] }, async ({ server }) => {
  const { w, s1 } = await inboxWorld(server);
  const crew = async () => (must(await w.owner.client.get("/api/identities"), "crew").json().identities as { id: number; handle: string }[]).filter((p) => p.handle === "docs");
  const before = await crew();
  expect(before).toHaveLength(1);

  // When the "devtool" session sends a profile change that targets identity "docs"
  const docsId = before[0]!.id;
  const attempts = [
    await patchProfile(w.srv.target, s1.lease, { identity: "docs", display_name: "Hijacked" }),
    await patchProfile(w.srv.target, s1.lease, { identity_id: docsId, display_name: "Hijacked" }),
    await send(w.srv.target, "PATCH", `/api/identities/${docsId}/profile`, { json: { display_name: "Hijacked" }, ...bearer(s1.lease) }),
  ];

  // Then the server refuses it
  expect(attempts.map((r) => r.status >= 400 && r.status < 500)).toEqual([true, true, true]);

  // And Crew shows the profile of "docs" unchanged
  expect(await crew()).toEqual(before);
});

scenario("Profile changes are limited to one per hour", { tag: ["@api"] }, async ({ server, testApi }) => {
  // Given "devtool" changed its profile 10 minutes ago
  const { w, s1 } = await inboxWorld(server);
  expect((await patchProfile(w.srv.target, s1.lease, { display_name: "Devtool Two" })).status).toBe(200);
  await testApi(w.srv).advanceClock(10 * 60_000);

  // When it changes its display name again
  const res = await patchProfile(w.srv.target, s1.lease, { display_name: "Devtool Three" });

  // Then the server answers 429 with a Retry-After of about 50 minutes
  expect(res.status).toBe(429);
  const seconds = Number(res.headers["retry-after"]);
  expect(seconds).toBeGreaterThan(49 * 60);
  expect(seconds).toBeLessThanOrEqual(50 * 60);
});

// Owner said: the agent "should request the connection accepted and send its id package for its handle."
scenario("The connect commands send the agent's own identity and print no secret", { tag: ["@cli"] }, async ({ server }) => {
  const srv = await server({ host: "localhost", adminSocket: true, env: { CONVOZ_TEST_POLL_MS: "250" } });
  const owner = await bootstrapOwner(srv);

  // When "convoz login --name box-5 --as code-review --description 'Reviews PRs'" runs on a new machine
  const box = new CliMachine();
  const login = box.startLogin(srv.origin, "box-5", ["--as", "code-review", "--description", "Reviews PRs"]);

  // Then the CLI prints 'Approve "box-5" as @code-review in Convoz.' and a code
  const line = await login.waitForStdout(/Approve "box-5" as @code-review in Convoz\. Code: [A-Z]{4}-[A-Z]{4}/);
  expect(line[0]).toContain('as @code-review in Convoz.');
  const [req] = must(await owner.client.get("/api/machines/requests"), "requests").json().requests as { id: number }[];
  must(await owner.client.post(`/api/machines/requests/${req!.id}/approve`, {}), "approve", 201);
  const done = await login.done;

  // And "convoz login --as" with a handle that is not a handle exits 2 and names the rule
  const bad = await new CliMachine().run(["login", "--server", srv.origin, "--name", "box-6", "--as", "9Bad_Handle"]);
  expect(bad.code).toBe(2);
  expect(bad.stderr).toMatch(/2 to 40 characters/);

  // And "convoz session start --create" without a name starts the request and prints no key, device code or lease
  const asking = box.start(["session", "start", "--as", "dev-ci", "--create"]);
  await expect.poll(() => asking.stderr()).toMatch(/Waiting for the owner/);
  const pending = must(await owner.client.get("/api/now"), "now").json().identity_requests as { ref: string }[];
  expect(pending).toHaveLength(1);
  must(await owner.client.post(`/api/identity-requests/${pending[0]!.ref}/deny`, {}), "deny");
  const refused = await asking.done;

  // And no output contains "cvz_"
  for (const r of [done, bad, refused]) expect(r.stdout + r.stderr).not.toContain("cvz_");
});

// ---- files ----------------------------------------------------------------------------------------------------------

const NOTES = Buffer.from("TESTONLY notes\nline two\n");

/** Background of the file scenarios: conversation "Files" holds "devtool" and a message of the owner that carries notes.txt. "docs" is not in it. */
async function fileWorld(server: Parameters<typeof chatWorld>[0]) {
  const w = await chatWorld(server, { agents: ["devtool", "docs"] });
  const conv = await createConversation(w.owner, { title: "Files", participants: ["devtool"] });
  const up = await uploadWhole({ srv: w.srv, owner: w.owner }, conv, "file", "notes.txt", NOTES);
  must(await postWith({ srv: w.srv, owner: w.owner }, conv, "The notes are attached", [up.id]), "post the file", 201);
  return { w, conv, id: up.id };
}

scenario("An agent saves an attachment with convoz file", { tag: ["@cli"] }, async ({ server }) => {
  // Given a message in conversation 41 carries the file "notes.txt"
  const { w, conv, id } = await fileWorld(server);
  const devtool = await startSession(w.box, "devtool", "files");

  // When "devtool" runs "convoz read 41"
  const read = await convoz(w.box, devtool.sid, ["read", String(conv)]);

  // Then the output has the line "[file: notes.txt (<id>)]" for the file
  expect(read.code, read.stderr).toBe(0);
  expect(read.stdout).toContain(`  [file: notes.txt (${id})]\n`);

  // When "devtool" runs "convoz file -o <path> <id>"
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "convoz-file-"));
  const out = path.join(dir, "got.txt");
  const saved = await convoz(w.box, devtool.sid, ["file", "-o", out, id]);

  // Then the file at that path holds the bytes that were sent
  expect(saved.code, saved.stderr).toBe(0);
  expect(fs.readFileSync(out)).toEqual(NOTES);

  // And "convoz file -o - <id>" writes the same bytes to standard output
  const piped = await convoz(w.box, devtool.sid, ["file", "-o", "-", id]);
  expect(piped.stdout).toBe(NOTES.toString());

  // And an agent that is not in conversation 41 cannot fetch the file
  const docs = await startSession(w.box, "docs", "files-docs");
  const refused = await convoz(w.box, docs.sid, ["file", "-o", "-", id]);
  expect(refused.code).not.toBe(0);
  expect(refused.stdout).toBe("");

  // Without -o the file goes to ./<id>_<name> and is never overwritten
  const plain = await convoz(w.box, devtool.sid, ["file", id]);
  expect(plain.stdout.trim()).toBe(`${id}_notes.txt`);
  expect(fs.readFileSync(path.join(w.box.home, `${id}_notes.txt`))).toEqual(NOTES);
  expect((await convoz(w.box, devtool.sid, ["file", id])).code).not.toBe(0);
});

scenario("An agent saves an attachment with the MCP file tool", { tag: ["@mcp"] }, async ({ server }) => {
  // Given a message in conversation 41 carries the file "notes.txt"
  const { w, id } = await fileWorld(server);
  const mcp = await McpClient.start(w.box, "devtool", "claude-TESTONLY-mcp-file");
  try {
    // When the "file" tool is called with the id of the file and a path
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "convoz-mcp-file-"));
    const out = path.join(dir, "got.txt");
    const result = await mcp.tool("file", { id, path: out });

    // Then the answer names that path and the file there holds the bytes that were sent
    expect(result.isError ?? false).toBe(false);
    expect(result.structuredContent).toMatchObject({ id, path: out, name: "notes.txt", size: NOTES.length });
    expect(fs.readFileSync(out)).toEqual(NOTES);
  } finally {
    mcp.end();
  }
});
