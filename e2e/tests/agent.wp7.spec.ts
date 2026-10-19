import path from "node:path";
import { emptyDir, machineVia, McpClient, refusingProxy, stallServer, stubClaude, treeOf } from "../lib/agent-wp7.ts";
import { chatWorld, convoz, createConversation, inboxItems, ownerSays, startSession } from "../lib/chat.ts";
import { sidOf } from "../lib/cli.ts";
import { faultProxy } from "../lib/fault-proxy.ts";
import { convozBin } from "../lib/fixtures.ts";
import { pageOf } from "../lib/messages-wp4.ts";
import { sessionsOf } from "../lib/machines.ts";
import { expect, scenario } from "../lib/scenario.ts";

/*
 * THE CLI AND THE MCP SERVER (WP7): specs/features/cli-mcp.feature. The watch, post, ack, add and leave scenarios of that file belong
 * to the chat work packages; "status shows in Crew" belongs to the Crew work package (the status route is not in this build).
 * The Background is the same for all: a fresh server with owner "drew", machine "box-2" logged in with allow-list "devtool", and
 * "devtool" an active participant of conversation 41.
 */

async function world(server: Parameters<typeof chatWorld>[0]) {
  const w = await chatWorld(server, { agents: ["devtool"] });
  const conv = await createConversation(w.owner, { title: "Ship search filters", participants: ["devtool"] });
  return { ...w, conv };
}

const TOOLS = ["whoami", "brief", "inbox", "claim", "ack", "read", "search", "post", "reply", "ask", "status", "handoff", "profile", "app_validate", "app_build", "rename", "typing", "invite", "file", "plan", "new", "agents"];

// ---- Rule: Setup registers the MCP server and prints a prompt with no secret -----------------------------------------------

scenario("Setup registers convoz mcp with Claude Code when the command exists", { tag: ["@cli"] }, async ({ server }) => {
  // Background, and a stub "claude" command on PATH that records its argv
  const w = await world(server);
  const claude = stubClaude();

  // When "convoz setup --as devtool --scope project" runs
  const res = await w.box.run(["setup", "--as", "devtool", "--scope", "project"], { env: { PATH: claude.dir } });
  expect(res.code, res.stderr).toBe(0);

  // Then the stub recorded "mcp add" with "convoz mcp --as devtool"
  const argv = claude.recorded() ?? [];
  expect(argv.slice(0, 2)).toEqual(["mcp", "add"]);
  expect(argv.slice(2, 4)).toEqual(["--scope", "project"]);
  const dashes = argv.indexOf("--");
  expect(argv[dashes - 1]).toBe("convoz");
  expect(argv.slice(dashes + 2)).toEqual(["mcp", "--as", "devtool"]);
  expect(path.basename(argv[dashes + 1] ?? "")).toBe(path.basename(convozBin));

  // And the CLI prints "You're @devtool on Convoz. Run convoz brief first."
  expect(res.stdout).toContain("You're @devtool on Convoz. Run convoz brief first.");

  // And no output contains "cvz_"
  expect(res.stdout + res.stderr).not.toContain("cvz_");
});

scenario("Setup prints the config when Claude Code is absent", { tag: ["@cli"] }, async ({ server }) => {
  // Background, and no "claude" command on PATH
  const w = await world(server);
  const before = treeOf(w.box.home, w.box.configDir);

  // When "convoz setup --as devtool" runs
  const res = await w.box.run(["setup", "--as", "devtool"], { env: { PATH: emptyDir() } });
  expect(res.code, res.stderr).toBe(0);

  // Then the CLI prints the MCP server config to add by hand
  const config = JSON.parse(res.stdout.slice(res.stdout.indexOf("{"), res.stdout.lastIndexOf("}") + 1));
  expect(config.mcpServers.convoz.args).toEqual(["mcp", "--as", "devtool"]);
  expect(path.basename(config.mcpServers.convoz.command)).toBe(path.basename(convozBin));
  expect(res.stdout).toContain("You're @devtool on Convoz. Run convoz brief first.");

  // And no file outside "~/.config/convoz" changed
  expect(treeOf(w.box.home, w.box.configDir)).toEqual(before);
});

scenario("The MCP server lists self-describing tools", { tag: ["@mcp"] }, async ({ server }) => {
  // Background
  const w = await world(server);
  const mcp = await McpClient.start(w.box, "devtool", "claude-TESTONLY-list");
  try {
    // When a client lists the tools of "convoz mcp --as devtool"
    const tools = await mcp.listTools();

    // Then the tools are whoami, brief, inbox, claim, ack, read, search, post, reply, ask, status, handoff, profile, app_validate, app_build and rename
    expect(tools.map((t) => t.name).sort()).toEqual([...TOOLS].sort());

    // And each has a one-line purpose and a JSON schema that validates
    for (const t of tools) {
      expect(t.description, t.name).toMatch(/^[^\n]{10,240}$/);
      expect(t.inputSchema.type, t.name).toBe("object");
      expect(t.inputSchema.additionalProperties, t.name).toBe(false);
      expect(t.inputSchema.$schema, t.name).toBe("https://json-schema.org/draft/2020-12/schema");
      for (const [name, p] of Object.entries<{ description?: string }>(t.inputSchema.properties)) expect(typeof p.description, `${t.name}.${name}`).toBe("string");
      const refused = await mcp.tool(t.name, { notAnArgument: 1 });
      expect(refused.isError, t.name).toBe(true);
      expect(refused.content[0]!.text, t.name).toContain("not valid");
    }
    const sample = await mcp.tool("whoami");
    expect(sample.structuredContent).toMatchObject({ identity: "devtool", machine: "box-2" });
    expect(JSON.stringify(sample)).not.toContain("cvz_");

    // And post, reply and ask accept an app in the app.v1 shape
    for (const name of ["post", "reply", "ask"]) {
      const app = tools.find((t) => t.name === name)!.inputSchema.properties.app;
      expect(app.required, name).toEqual(["v", "type", "fallback", "props"]);
      expect(app.properties.v.const, name).toBe(1);
      expect(app.properties.type.enum, name).toContain("chart");
    }
    const withApp = await mcp.tool("post", { conversation: w.conv, text: "A chart", needs_you: false, app: { v: 1, type: "code", title: "Code", fallback: "Code", props: { mode: "code", text: "x" } } });
    expect(withApp.isError, withApp.content[0]?.text).not.toBe(true);
    const badApp = await mcp.tool("post", { conversation: w.conv, text: "A chart", needs_you: false, app: { v: 2, type: "code", fallback: "x", props: {} } });
    expect(badApp.isError).toBe(true);
  } finally {
    mcp.end();
    await mcp.exited;
  }
});

scenario("The MCP server ends its lease on exit", { tag: ["@mcp"] }, async ({ server }) => {
  // Given "convoz mcp --as devtool" is running with a live session
  const w = await world(server);
  const claude = "claude-TESTONLY-leave";
  const mcp = await McpClient.start(w.box, "devtool", claude);
  const mine = async () => (await sessionsOf(w.owner)).filter((s) => s.client_id === claude);
  expect((await mine()).map((s) => s.state)).toEqual(["live"]);

  // When its stdin closes
  const closed = Date.now();
  mcp.end();

  // Then Crew -> Sessions shows that session as ended within 2 seconds
  let state = "live";
  while (state === "live" && Date.now() - closed < 2000) {
    await new Promise((r) => setTimeout(r, 50));
    state = (await mine())[0]!.state;
  }
  expect(state).toBe("ended");
  expect(Date.now() - closed).toBeLessThanOrEqual(2000);
  expect(await mcp.exited).toBe(0);
});

// ---- Rule: Retries never duplicate and never hide a client error -----------------------------------------------------------

scenario("A post retried after a lost response makes one message", { tag: ["@cli"] }, async ({ server }) => {
  // Given a fault proxy drops the response of the first "convoz post" request
  const w = await world(server);
  const direct = await startSession(w.box, "devtool", "poster");
  const route = `/api/conversations/${w.conv}/messages`;
  const proxy = await faultProxy(w.srv.target, { method: "POST", path: route, nth: 1 });
  try {
    const via = await machineVia(proxy.url, w.box2.key, w.box, direct.sid);

    // When "convoz post 41 'Build is green'" runs
    const res = await via.run(["post", "--fyi", "--sid", direct.sid, "--timeout", "10s", String(w.conv), "Build is green"], { timeoutMs: 40_000 });

    // Then the proxy log shows 2 requests with the same client id
    const sent = proxy.entries("POST", route);
    expect(sent).toHaveLength(2);
    expect(sent[0]!.dropped).toBe(true);
    expect(sent[1]!.bodyHash).toBe(sent[0]!.bodyHash);

    // And conversation 41 shows "Build is green" once
    expect((await pageOf(w.owner, w.conv, "limit=100")).filter((m) => m.body === "Build is green")).toHaveLength(1);

    // And the CLI exits 0
    expect(res.code, res.stderr).toBe(0);
  } finally {
    await proxy.close();
  }
});

scenario("Exit codes tell scripts what went wrong", { tag: ["@cli"] }, async ({ server, testApi }, info) => {
  info.setTimeout(120_000);
  const w = await world(server);
  const s1 = await startSession(w.box, "devtool", "s1");
  const route = `/api/conversations/${w.conv}/messages`;

  // "convoz post" runs with no conversation argument -> 2
  const noConversation = await convoz(w.box, s1.sid, ["post"]);
  expect(noConversation.code).toBe(2);

  // "convoz post 41 hi" runs with an ended session -> 3
  const gone = await startSession(w.box, "devtool", "gone");
  expect((await w.box.sessionEnd(gone.sid)).code).toBe(0);
  const ended = await convoz(w.box, gone.sid, ["post", "--fyi", String(w.conv), "hi"]);
  expect(ended.code).toBe(3);
  expect(ended.stderr).toContain("session ended");

  // "convoz ack" runs with a claim token that another session replaced -> 4
  const s2 = await startSession(w.box, "devtool", "s2");
  await ownerSays(w.owner, w.conv, "@devtool status?");
  const [old] = await inboxItems(w.box, s1.sid, ["--claim", "1", "--wait", "0", "--visibility", "30s"]);
  await testApi(w.srv).advanceClock(31_000);
  const [taken] = await inboxItems(w.box, s2.sid, ["--claim", "1", "--wait", "0"]);
  expect(taken?.id).toBe(old!.id);
  const lost = await convoz(w.box, s1.sid, ["ack", `${old!.id}:${old!.claim_token}`]);
  expect(lost.code).toBe(4);
  expect(lost.stderr).toContain("claim_lost");

  // Convoz refuses five tries in a row as rate limited -> 5
  const refusing = await refusingProxy(w.srv.target, { method: "POST", path: route, status: 429 });
  try {
    const limited = await machineVia(refusing.url, w.box2.key, w.box, s1.sid);
    const res = await limited.run(["post", "--sid", s1.sid, "--timeout", "10s", String(w.conv), "hi"], { timeoutMs: 60_000 });
    expect(res.code, res.stderr).toBe(5);
    expect(refusing.hits).toHaveLength(5);
  } finally {
    await refusing.close();
  }

  // the server is unreachable for five tries in a row -> 6
  const down = await stallServer("drop");
  try {
    const nowhere = await machineVia(down.url, w.box2.key, w.box, s1.sid);
    const res = await nowhere.run(["post", "--sid", s1.sid, "--timeout", "10s", String(w.conv), "hi"], { timeoutMs: 60_000 });
    expect(res.code, res.stderr).toBe(6);
    expect(down.hits).toHaveLength(5);
  } finally {
    await down.close();
  }
});

scenario("The CLI gives up on a dead link in bounded time", { tag: ["@cli"] }, async ({ server }, info) => {
  info.setTimeout(150_000);
  // Given the stall proxy holds every connection without answering
  const w = await world(server);
  const s = await startSession(w.box, "devtool", "poster");
  const stall = await stallServer("hold");
  try {
    const dead = await machineVia(stall.url, w.box2.key, w.box, s.sid);

    // When "convoz post 41 hello" runs
    const started = Date.now();
    const res = await dead.run(["post", "--sid", s.sid, String(w.conv), "hello"], { timeoutMs: 110_000 });

    // Then the CLI exits 6 within 90 seconds
    expect(res.code, res.stderr).toBe(6);
    expect(Date.now() - started).toBeLessThan(90_000);
    expect(stall.hits).toHaveLength(5);
  } finally {
    await stall.close();
  }
});

// ---- Rule: Identity comes from the lease; agents change only their own profile -----------------------------------------------

scenario("whoami shows machine, identity, session and scopes", { tag: ["@cli"] }, async ({ server }) => {
  // Given two live sessions of "devtool", the first with a label of its own
  const w = await world(server);
  const first = await w.box.sessionStart("devtool", ["--label", "build box shell"], { claude: "claude-TESTONLY-first" });
  const sid = sidOf(first);
  await startSession(w.box, "devtool", "second");

  // When "convoz whoami --json" runs as "devtool"
  const res = await w.box.whoami(["--sid", sid, "--json"]);
  expect(res.code, res.stderr).toBe(0);

  // Then it shows machine "box-2", identity "devtool", the session label, the scopes and the live sessions of "devtool"
  const who = JSON.parse(res.stdout);
  expect(who).toMatchObject({ machine: "box-2", identity: "devtool", label: "build box shell", session: sid, live_sessions: 2 });
  expect(who.scopes).toEqual(expect.arrayContaining(["read", "post"]));
  expect(res.stdout).not.toContain("cvz_");
});

scenario("An agent changes its own profile", { tag: ["@cli"] }, async ({ server }) => {
  // Background
  const w = await world(server);
  const s = await startSession(w.box, "devtool", "s1");

  // When "convoz profile --set name='Dev Tool' description='Builds and tests' capabilities=go,ci" runs as "devtool"
  const res = await convoz(w.box, s.sid, ["profile", "--set", "name=Dev Tool", "description=Builds and tests", "capabilities=go,ci"]);
  expect(res.code, res.stderr).toBe(0);

  // Then Crew shows "Dev Tool @devtool" with that description and capabilities
  const crew = (await w.owner.client.get("/api/identities")).json().identities as { handle: string; display_name: string; description?: string; capabilities?: string[] }[];
  expect(crew.find((i) => i.handle === "devtool")).toMatchObject({ display_name: "Dev Tool", description: "Builds and tests", capabilities: ["go", "ci"] });

  // and the profile changes once an hour, and the handle never
  const again = await convoz(w.box, s.sid, ["profile", "--set", "description=Something else"]);
  expect(again.code).toBe(5);
  const shown = await convoz(w.box, s.sid, ["profile", "--json"]);
  expect(JSON.parse(shown.stdout)).toMatchObject({ handle: "devtool", display_name: "Dev Tool", description: "Builds and tests" });
});
