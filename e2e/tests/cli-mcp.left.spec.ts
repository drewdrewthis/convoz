import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { McpClient, machineVia } from "../lib/agent-wp7.ts";
import { convoz, messagesOf, ownerSays } from "../lib/chat.ts";
import { send } from "../lib/http.ts";
import { forwarder, inboxWorld } from "../lib/left.ts";
import { bearer } from "../lib/machines.ts";
import { must } from "../lib/owner.ts";
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
