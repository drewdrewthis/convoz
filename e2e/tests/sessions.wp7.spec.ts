import { McpClient } from "../lib/agent-wp7.ts";
import { chatWorld, createConversation, ownerSays } from "../lib/chat.ts";
import { sessionsOf } from "../lib/machines.ts";
import { pageOf } from "../lib/messages-wp4.ts";
import { expect, scenario } from "../lib/scenario.ts";

/*
 * MCP SESSIONS (WP7): the three scenarios of specs/features/sessions.feature about `convoz mcp`. A Claude session is the value of
 * CLAUDE_CODE_SESSION_ID: the MCP server, the Bash calls and the subagents of one Claude session all run with it, and it is the
 * client id of their one lease. "Crew -> Sessions" is GET /api/sessions.
 */

async function world(server: Parameters<typeof chatWorld>[0]) {
  const w = await chatWorld(server, { agents: ["devtool"] });
  const conv = await createConversation(w.owner, { title: "Ship search filters", participants: ["devtool"] });
  return { ...w, conv };
}

const liveOf = async (w: Awaited<ReturnType<typeof world>>, claude: string) => (await sessionsOf(w.owner)).filter((s) => s.client_id === claude && s.state === "live");

scenario("Calls inside one Claude session share one lease", { tag: ["@mcp"] }, async ({ server }) => {
  // Given a Claude session whose environment has CLAUDE_CODE_SESSION_ID
  const w = await world(server);
  const claude = "claude-TESTONLY-share";

  // And "convoz mcp --as devtool" runs inside that Claude session
  const mcp = await McpClient.start(w.box, "devtool", claude);
  try {
    const viaMcp = await mcp.tool("post", { conversation: w.conv, text: "hello from the mcp tool" });
    expect(viaMcp.isError, viaMcp.content[0]?.text).not.toBe(true);

    // When the same Claude session runs "convoz post 41 hello" in Bash
    const bash = await w.box.run(["post", "--as", "devtool", String(w.conv), "hello from bash"], { claude, timeoutMs: 20_000 });
    expect(bash.code, bash.stderr).toBe(0);

    // Then the message is attributed to the same session label as the MCP calls
    const page = await pageOf(w.owner, w.conv, "limit=100");
    const fromMcp = page.find((m) => m.body === "hello from the mcp tool")!;
    const fromBash = page.find((m) => m.body === "hello from bash")!;
    expect([fromBash.session_label, fromBash.machine]).toEqual([fromMcp.session_label, fromMcp.machine]);
    expect(fromBash.machine).toBe("box-2");

    // And Crew -> Sessions shows one live session for that Claude session
    expect(await liveOf(w, claude)).toHaveLength(1);
    expect((await sessionsOf(w.owner)).filter((s) => s.state === "live")).toHaveLength(1);
  } finally {
    mcp.end();
    await mcp.exited;
  }
});

scenario("A subagent shares its Claude session's lease and claims", { tag: ["@cli", "@mcp"] }, async ({ server }) => {
  // Given "convoz mcp --as devtool" runs in a Claude session that holds a claimed mention item
  const w = await world(server);
  const claude = "claude-TESTONLY-subagent";
  await ownerSays(w.owner, w.conv, "@devtool please look at the failing test");
  const mcp = await McpClient.start(w.box, "devtool", claude);
  try {
    const claimed = await mcp.tool("claim", { n: 1 });
    const [item] = claimed.structuredContent.items as { id: number; claim_token: string; reason: string }[];
    expect(item?.reason).toBe("mention");

    // When a subagent of that Claude session runs "convoz ack" for that item with its token
    const subagent = await w.box.run(["ack", "--as", "devtool", `${item!.id}:${item!.claim_token}`], { claude, timeoutMs: 20_000 });

    // Then the ack works
    expect(subagent.code, subagent.stderr).toBe(0);
    expect(subagent.stdout).toContain(`${item!.id} ok`);
    expect((await mcp.tool("inbox", { peek: true })).structuredContent.items).toEqual([]);

    // And Crew -> Sessions shows one live session for that Claude session
    expect(await liveOf(w, claude)).toHaveLength(1);
  } finally {
    mcp.end();
    await mcp.exited;
  }
});

scenario("A restarted MCP server in the same Claude session keeps working", { tag: ["@mcp"] }, async ({ server }) => {
  // Given "convoz mcp --as devtool" runs in a Claude session and holds a claimed mention item
  const w = await world(server);
  const claude = "claude-TESTONLY-restart";
  await ownerSays(w.owner, w.conv, "@devtool please look at the failing test");
  const first = await McpClient.start(w.box, "devtool", claude);
  const held = await first.tool("claim", { n: 1 });
  const [item] = held.structuredContent.items as { id: number; claim_token: string }[];
  expect(item?.claim_token).toBeTruthy();

  // When the MCP server process restarts in that Claude session
  first.kill();
  await first.exited;
  const second = await McpClient.start(w.box, "devtool", claude);
  try {
    // Then the next tool call works
    const who = await second.tool("whoami");
    expect(who.isError, who.content[0]?.text).not.toBe(true);
    expect(who.structuredContent).toMatchObject({ identity: "devtool", machine: "box-2" });

    // And Crew -> Sessions shows one live session for that Claude session
    expect(await liveOf(w, claude)).toHaveLength(1);

    // And the mention item is still held by it and can be acked
    const again = await second.tool("claim", { n: 1 });
    expect(again.structuredContent.items).toEqual([expect.objectContaining({ id: item!.id, claim_token: item!.claim_token, state: "claimed" })]);
    const acked = await second.tool("ack", { items: [`${item!.id}:${item!.claim_token}`] });
    expect(acked.isError, acked.content[0]?.text).not.toBe(true);
  } finally {
    second.end();
    await second.exited;
  }
});
