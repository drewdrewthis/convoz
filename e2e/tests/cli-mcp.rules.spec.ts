import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { McpClient } from "../lib/agent-wp7.ts";
import { chatWorld } from "../lib/chat.ts";
import { send } from "../lib/http.ts";
import { expect, repoRoot, scenario } from "../lib/scenario.ts";

// Owner, msgs 557 and 791: the skill went stale. It is a stable pointer now; the server holds the rules (specs/features/cli-mcp.feature).

scenario("convoz rules prints the server's rules", { tag: ["@cli"] }, async ({ server }) => {
  const w = await chatWorld(server, { agents: ["devtool"] });

  // When "devtool" runs "convoz rules"
  const rules = await w.box.run(["rules", "--as", "devtool"]);

  // Then the CLI exits 0 and prints the rules text of the server
  const served = (await send(w.srv.target, "GET", "/api/rules")).json().text as string;
  expect({ code: rules.code, stderr: rules.stderr }).toEqual({ code: 0, stderr: "" });
  expect(rules.stdout).toBe(`${served}\n`);
  expect(served).toContain("Send an `ask` only for a one-way door");

  // And the installed skill is a short pointer that tells the agent to run "convoz rules" first
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "convoz-skill-")), "skills", "convoz");
  expect((await w.box.run(["skill", "install", "--dir", dir])).code).toBe(0);
  const installed = fs.readFileSync(path.join(dir, "SKILL.md"), "utf8");
  expect(installed.split("\n").length).toBeLessThanOrEqual(20);
  expect(installed).toContain("`convoz rules`");
  expect(installed).not.toContain("one-way door");

  // And the two skill files have the same body
  const plugin = fs.readFileSync(path.join(repoRoot, "plugins/convoz/skills/convoz/SKILL.md"), "utf8");
  expect(plugin).toBe(fs.readFileSync(path.join(repoRoot, "apps/convoz/internal/cli/skill.md"), "utf8"));
  expect(plugin).toBe(installed);
});

scenario("The brief and the MCP instructions carry the same rules", { tag: ["@cli", "@mcp"] }, async ({ server }) => {
  const w = await chatWorld(server, { agents: ["devtool"] });
  const served = (await send(w.srv.target, "GET", "/api/rules")).json().text as string;
  const claude = "claude-TESTONLY-rules";

  // When "devtool" runs "convoz brief" and a client starts "convoz mcp --as devtool"
  const brief = await w.box.run(["brief", "--as", "devtool"], { claude });
  const mcp = await McpClient.start(w.box, "devtool", claude);
  try {
    // Then the brief carries the rules text of the server
    expect(brief.code, brief.stderr).toBe(0);
    expect(brief.stdout).toContain(served);

    // And the MCP instructions carry the same rules text
    expect(mcp.instructions).toContain(served);
  } finally {
    mcp.end();
  }
});
