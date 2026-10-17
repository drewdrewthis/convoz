import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { send } from "../lib/http.ts";
import { bearer } from "../lib/machines.ts";
import { leaseOf, msgWorld } from "../lib/messages-wp4.ts";
import { baseEnv, expect, repoRoot, run, scenario } from "../lib/scenario.ts";

/*
 * MESSAGES AND TYPES (WP18): "Status updates are rate limited" (design 13.1: 1 per 5 s, burst 10, per identity) and the
 * regression scenario "The draft-8 message rules still hold" (AC-M14).
 */

scenario("Status updates are rate limited", { tag: ["@api"] }, async ({ server, dataDir }) => {
  // Background
  const w = await msgWorld({ server, dataDir });
  const lease = await leaseOf(w, "devtool");

  // When "devtool" sets its status 11 times in 1 second
  const started = Date.now();
  const answers: number[] = [];
  let last = await send(w.srv.target, "PUT", "/api/status", { json: { state: "working", doing: "step 0" }, ...bearer(lease) });
  answers.push(last.status);
  for (let i = 1; i < 11; i++) {
    last = await send(w.srv.target, "PUT", "/api/status", { json: { state: "working", doing: `step ${i}` }, ...bearer(lease) });
    answers.push(last.status);
  }
  expect(Date.now() - started, "the 11 updates took less than a second").toBeLessThan(1_000);

  // Then the eleventh answers 429
  expect(answers).toEqual([...Array<number>(10).fill(200), 429]);
  expect(Number(last.headers["retry-after"]), "the refusal says when to come back").toBeGreaterThan(0);

  // Control: another agent has its own budget
  const docs = await leaseOf(w, "docs");
  expect((await send(w.srv.target, "PUT", "/api/status", { json: { state: "idle" }, ...bearer(docs) })).status).toBe(200);
});

// ---- AC-M14: the draft-8 rules, on the S2 and S6 scenarios unchanged -----------------------------------------

/** The scenarios of the S2 and S6 suites for the five draft-8 rules, by the title the feature files give them. */
const DRAFT8: Record<string, string[]> = {
  "thread rules (I-8)": ["Thread structure rules", "A message never moves to another conversation, thread or author"],
  "unread math (I-14)": [
    "The unread count caps at 99+",
    "Messages that never count as unread",
    "Replies in a thread the owner is not in never make the conversation bold",
    "Replies in a thread the owner replied in count as unread",
    "A broadcast reply read in its thread is read in the main list",
  ],
  "the loop breaker (I-16)": [
    "The twentieth agent message in a row pauses the conversation",
    "A human message lets agents post again",
    "Thread replies count toward the loop",
    "While paused, agent posts and asks are refused",
    "A message sent through an app does not reset the loop counter",
  ],
  "file serving (I-44)": ["Only safe images and audio are shown inline", "A pixel bomb is refused before decode", "The size cap applies to the bytes streamed", "Audio is served inline with safe headers"],
  "markdown links (I-45)": ["Dangerous link schemes render as text", "An external link shows its real host", "An image from an own upload renders inline"],
};

/** Every scenario of the feature files: its title and its tags. */
function scenariosOfSpecs(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : e.name.endsWith(".feature") ? [path.join(dir, e.name)] : []));
  for (const file of walk(path.join(repoRoot, "specs"))) {
    let tags: string[] = [];
    for (const line of fs.readFileSync(file, "utf8").split("\n").map((l) => l.trim())) {
      if (line.startsWith("@")) tags = line.split(/\s+/);
      else if (/^Scenario( Outline)?:/.test(line)) {
        out.set(line.replace(/^Scenario( Outline)?:\s*/, ""), tags);
        tags = [];
      } else if (line && !line.startsWith("#")) tags = [];
    }
  }
  return out;
}

interface JsonSpec {
  title: string;
  tests: { projectName: string; expectedStatus: string; status: string; results: { status: string }[] }[];
}
const specsOf = (suite: { specs?: JsonSpec[]; suites?: unknown[] }): JsonSpec[] => [...(suite.specs ?? []), ...(suite.suites ?? []).flatMap((s) => specsOf(s as typeof suite))];

scenario("The draft-8 message rules still hold", { tag: ["@browser"] }, async ({}, info) => {
  info.setTimeout(280_000);
  const titles = Object.values(DRAFT8).flat();
  const specs = scenariosOfSpecs();

  // Given the scenarios for the five rules are in the specs, in force and bound (a deleted or parked one is not "unchanged")
  const parked = titles.filter((t) => !specs.has(t) || !specs.get(t)!.includes("@v1") || specs.get(t)!.includes("@unimplemented"));
  expect(parked, "scenarios missing, not @v1, or still @unimplemented").toEqual([]);

  // When the S2 and S6 scenarios for thread rules, unread math, the loop breaker, file serving and markdown links run
  // (in a run of their own: its own output folder and report, so it cannot touch this run's)
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "convoz-draft8-"));
  const escaped = titles.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const grep = `\\s(?:${escaped.join("|")})(?:\\s@\\S+)*$`;
  const res = await run(
    process.execPath,
    [path.join(repoRoot, "e2e", "node_modules", "@playwright", "test", "cli.js"), "test", "--config", path.join(repoRoot, "e2e", "playwright.config.ts"), "--project=headless", "--project=chromium", "--workers=4", "--reporter=json", "--output", path.join(out, "results"), "--grep", grep],
    { cwd: path.join(repoRoot, "e2e"), env: baseEnv({ CI: "1" }), timeoutMs: 270_000 },
  );
  const report = JSON.parse(res.stdout) as { suites: { specs?: JsonSpec[]; suites?: unknown[] }[] };
  const ran = report.suites.flatMap(specsOf);
  fs.writeFileSync(path.join(out, "report.json"), res.stdout);

  // Then every one passes unchanged
  const outcome = Object.fromEntries(ran.map((s) => [s.title, s.tests.map((t) => `${t.projectName}:${t.status}:${t.results.at(-1)?.status}`)]));
  expect(Object.keys(outcome).sort(), "the run holds exactly these scenarios").toEqual([...titles].sort());
  expect(Object.values(outcome).filter((runs) => runs.length !== 1), "each scenario ran once").toEqual([]);
  const notPassed = Object.entries(outcome).flatMap(([title, runs]) => runs.filter((r) => !r.endsWith(":expected:passed")).map((r) => `${title}: ${r}`));
  expect(notPassed).toEqual([]);
  expect(res.code, res.stderr.slice(-400)).toBe(0);
});
