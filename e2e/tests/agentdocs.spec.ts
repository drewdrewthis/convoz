import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chatWorld, createConversation, startSession, startWatch, watchLines } from "../lib/chat.ts";
import { ownerSendsVoice, scriptEngine } from "../lib/bind.ts";
import { crewWorld, sheetNamed } from "../lib/crew-wp9.ts";
import { expect, scenario } from "../lib/scenario.ts";

// Owner, msg 257: "how to teach agents about convoz ... Maybe we should ship a skill?" (specs/features/cli-mcp.feature, onboarding.feature)

scenario("convoz skill install writes a skill that teaches the Convoz rules", { tag: ["@cli"] }, async ({ server }) => {
  const w = await chatWorld(server, { agents: ["devtool"] });
  const claude = fs.mkdtempSync(path.join(os.tmpdir(), "convoz-skill-")); // stands in for ~/.claude
  const dir = path.join(claude, "skills", "convoz");

  // When "devtool" runs "convoz skill install --dir <folder>"
  const first = await w.box.run(["skill", "install", "--dir", dir]);

  // Then the CLI exits 0 and prints the path of SKILL.md
  expect({ code: first.code, stderr: first.stderr }).toEqual({ code: 0, stderr: "" });
  expect(first.stdout.split("\n")[0]).toBe(`installed ${path.join(dir, "SKILL.md")}`);

  // And SKILL.md has the name "convoz" and the rule to ask only the owner's call
  const text = fs.readFileSync(path.join(dir, "SKILL.md"), "utf8");
  expect(text).toMatch(/^---\nname: convoz\n/);
  expect(text).toContain("Send an `ask` only for a one-way door");
  expect(text).toBe((await w.box.run(["skill"])).stdout);

  // And no hooks are added unless asked: settings.json appears with --hooks, once, even after a second run
  expect(fs.existsSync(path.join(claude, "settings.json"))).toBe(false);
  expect((await w.box.run(["skill", "install", "--dir", dir, "--hooks"])).stdout).toContain("hooks added");
  expect((await w.box.run(["skill", "install", "--dir", dir, "--hooks"])).stdout).not.toContain("hooks added");
  const hooks = JSON.parse(fs.readFileSync(path.join(claude, "settings.json"), "utf8")).hooks;
  expect(hooks.Notification).toHaveLength(1);
  expect(hooks.UserPromptSubmit).toHaveLength(1);

  // And running it again prints "updated"
  expect((await w.box.run(["skill", "install", "--dir", dir])).stdout.split("\n")[0]).toBe(`updated ${path.join(dir, "SKILL.md")}`);
});

scenario("An agent watching gets a voice note's transcript as text", { tag: ["@cli"] }, async ({ server }) => {
  // Given "convoz watch --json" runs as "devtool"
  const w = await chatWorld(server, { agents: ["devtool"] });
  const conv = await createConversation(w.owner, { title: "Ship search filters", participants: ["devtool"] });
  const s = await startSession(w.box, "devtool", "watch");
  await scriptEngine({ srv: w.srv, owner: w.owner }, { text: "ship the filters on Thursday" });
  const watch = startWatch(w.box, s.sid);
  try {
    // When the owner sends a voice note in conversation 41
    await ownerSendsVoice({ srv: w.srv, owner: w.owner }, conv);

    // Then the stream line has the text "Voice note 0:03: ship the filters on Thursday"
    const [line] = (await watchLines(watch, 1, 20_000)) as { body: string; text?: string }[];
    expect(line?.text).toBe("Voice note 0:03: ship the filters on Thursday");
  } finally {
    watch.stop();
  }
});

scenario("The invite prompt tells a new agent to install the skill", { tag: ["@browser"] }, async ({ server, page, context }) => {
  const c = await crewWorld({ server, page, context }, { agents: ["devtool"] });
  await page.goto(`${c.w.srv.origin}/crew`);

  // When the owner opens the invite sheet
  await page.getByRole("button", { name: /^(Add|Invite) agent$/ }).first().click();
  const prompt = sheetNamed(page, "Invite agent").getByLabel("Connect prompt");

  // Then the prompt tells Claude Code to add the Convoz plugin, and any other agent to run "convoz skill install"
  await expect(prompt).toContainText("/plugin marketplace add drewdrewthis/convoz");
  await expect(prompt).toContainText("/plugin install convoz");
  await expect(prompt).toContainText("convoz skill install");
});

// Owner, conv 12 msg 281: "something happens on the agent's actually running thing on their server -- something grabs it and it
// presents a decision, or it needs an approval, or it gets logged out, or runs out of credits."
scenario("A stuck agent says why through its Claude Code hook", { tag: ["@cli"] }, async ({ server }) => {
  const w = await chatWorld(server, { agents: ["devtool"] });
  const s = await startSession(w.box, "devtool", "hook");

  // When Claude Code calls the Notification hook for "devtool" with "Claude needs your permission to use Bash"
  const run = await w.box.run(["hook", "notify", "--sid", s.sid], { stdin: JSON.stringify({ hook_event_name: "Notification", message: "Claude needs your permission to use Bash" }) });

  // Then the hook exits 0 and Crew shows "devtool" as blocked with that message
  expect(run.code).toBe(0);
  const crew = (await w.owner.client.get("/api/status")).json().statuses as { handle: string; state: string; doing: string }[];
  expect(crew.find((c) => c.handle === "devtool")).toMatchObject({ state: "blocked", doing: "Needs approval on its host: Claude needs your permission to use Bash" });

  // And when Claude Code calls the UserPromptSubmit hook, "devtool" is working again and the blocked text is gone
  expect((await w.box.run(["hook", "resume", "--sid", s.sid])).code).toBe(0);
  const after = (await w.owner.client.get("/api/status")).json().statuses as { handle: string; state: string; doing: string }[];
  expect(after.find((c) => c.handle === "devtool")).toMatchObject({ state: "working", doing: "" });
});
