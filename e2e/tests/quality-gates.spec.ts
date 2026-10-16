import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { baseEnv, expect, pnpmCommand, repoRoot, run, scenario } from "../lib/scenario.ts";

const py = (script: string, args: string[], extra: { cwd?: string; env?: Record<string, string>; timeoutMs?: number } = {}) =>
  run("python3", ["-I", script, ...args], { cwd: extra.cwd ?? repoRoot, env: baseEnv(extra.env ?? {}), timeoutMs: extra.timeoutMs ?? 20_000 });

const scratch = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), p));

scenario("The coverage matrix has no gap", { tag: ["@cli"] }, async () => {
  // Given a copy of the specs, so the repo's coverage.md is not rewritten
  const dir = scratch("convoz-specs-");
  fs.cpSync(path.join(repoRoot, "specs"), path.join(dir, "specs"), { recursive: true });

  // When "specs/scripts/check_specs.py specs --write-coverage" runs
  const res = await py(path.join(repoRoot, "specs/scripts/check_specs.py"), [path.join(dir, "specs"), "--write-coverage"]);

  // Then it exits 0
  expect(res.code, res.stdout + res.stderr).toBe(0);

  // And coverage.md lists no invariant, AC or AC-M without a scenario
  const cov = fs.readFileSync(path.join(dir, "specs", "coverage.md"), "utf8");
  expect(cov).toMatch(/- Invariants I-1…I-50: no scenario: none;/);
  expect(cov).toMatch(/- ACs AC-1…AC-29: no scenario: none;/);
  expect(cov).toMatch(/- Message and app ACs AC-M1…AC-M15: no scenario: none;/);
});

scenario("The checker keeps user-facing scenarios in the user's words", { tag: ["@cli"] }, async () => {
  // Given a scenario in specs/features that says "the server answers 409"
  const dir = scratch("convoz-specs-");
  fs.cpSync(path.join(repoRoot, "specs"), path.join(dir, "specs"), { recursive: true });
  const bad = [
    "Feature: Bad words TESTONLY",
    "",
    "  @v1 @cli",
    "  Scenario: A user scenario that names a status",
    "    When the owner posts twice",
    "    Then the server answers 409",
    "",
  ];
  fs.writeFileSync(path.join(dir, "specs", "features", "zz-bad.feature"), bad.join("\n"));
  const line = bad.findIndex((l) => l.includes("the server answers 409")) + 1;

  // When "specs/scripts/check_specs.py specs" runs
  const res = await py(path.join(repoRoot, "specs/scripts/check_specs.py"), [path.join(dir, "specs")]);

  // Then it exits 1 and names the file, the line and the rule
  expect(res.code).toBe(1);
  expect(res.stdout).toContain(`features/zz-bad.feature:${line}:`);
  expect(res.stdout).toContain("names an HTTP status");
});

scenario("Every text colour pair meets 4.5 to 1", { tag: ["@cli"] }, async () => {
  // When the tokens build runs
  const pnpm = pnpmCommand();
  const res = await run(pnpm.file, [...pnpm.prefix, "--filter", "@convoz/tokens", "build"], {
    cwd: repoRoot,
    env: baseEnv({ CI: "1" }),
    timeoutMs: 25_000,
  });

  // Then it exits 0 and prints a contrast report for every palette and both themes
  expect(res.code, res.stdout + res.stderr).toBe(0);
  const out = res.stdout.toLowerCase();
  for (const word of ["contrast", "iris", "ember", "tide", "mono", "light", "dark"]) expect(out).toContain(word);
  expect(res.stdout).toMatch(/\b\d+\.\d{1,2}:1\b/);
  expect(res.stdout).not.toMatch(/\bFAIL\b/);
});

scenario("The build uses only pinned inputs", { tag: ["@cli"] }, async ({}, info) => {
  info.setTimeout(60_000);
  // When scripts/check_pins.py runs (pins on Actions, pnpm and Go flags, go mod verify, SQLite module checksum)
  const res = await py(path.join(repoRoot, "scripts/check_pins.py"), [], {
    env: { GOFLAGS: "-mod=readonly", ...(process.env.GO_BIN ? { GO_BIN: process.env.GO_BIN } : {}) },
    timeoutMs: 55_000,
  });
  // Then it exits 0
  expect(res.code, res.stdout + res.stderr).toBe(0);
});

scenario("Changed scenarios are listed in the PR summary", { tag: ["@cli"] }, async () => {
  // Given a PR that edits the text of 2 scenarios and deletes 1
  const repo = scratch("convoz-diff-");
  const home = scratch("convoz-home-");
  const git = (...args: string[]) =>
    run("git", ["-c", "commit.gpgsign=false", "-c", "user.name=TESTONLY", "-c", "user.email=testonly@example.invalid", "-c", "init.defaultBranch=main", ...args], {
      cwd: repo,
      env: baseEnv({ HOME: home, GIT_CONFIG_NOSYSTEM: "1" }),
    });
  const feature = (a: string, b: string, c?: string) =>
    [
      "Feature: Demo TESTONLY",
      "",
      "  @v1 @cli",
      "  Scenario: Alpha",
      `    When ${a}`,
      "    Then it works",
      "",
      "  @v1 @cli",
      "  Scenario: Beta",
      `    When ${b}`,
      "    Then it works",
      ...(c === undefined ? [] : ["", "  @v1 @cli", "  Scenario: Gamma", `    When ${c}`, "    Then it works"]),
      "",
      "  @v1 @cli",
      "  Scenario: Delta",
      "    When nothing changes",
      "    Then it works",
      "",
    ].join("\n");
  const file = path.join(repo, "specs", "features", "demo.feature");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.mkdirSync(path.join(repo, "specs", "contracts"), { recursive: true });
  fs.writeFileSync(file, feature("a one", "b one", "c one"));
  expect((await git("init", "-q")).code).toBe(0);
  expect((await git("add", "-A")).code).toBe(0);
  expect((await git("commit", "-q", "-m", "base")).code).toBe(0);
  fs.writeFileSync(file, feature("a two", "b two"));
  expect((await git("commit", "-q", "-am", "head")).code).toBe(0);

  // When CI runs the spec diff step
  const summary = path.join(repo, "summary.md");
  const res = await py(path.join(repoRoot, "specs/scripts/spec_diff.py"), ["HEAD~1", "HEAD"], {
    cwd: repo,
    env: { HOME: home, GITHUB_STEP_SUMMARY: summary },
  });

  // Then the PR summary lists the 2 changed and the 1 deleted scenario by file and title, and the step does not block
  expect(res.code, res.stdout + res.stderr).toBe(0);
  const listed = [res.stdout, fs.existsSync(summary) ? fs.readFileSync(summary, "utf8") : ""];
  for (const text of listed) {
    expect(text).toMatch(/changed\s+features\/demo\.feature: Alpha/);
    expect(text).toMatch(/changed\s+features\/demo\.feature: Beta/);
    expect(text).toMatch(/removed\s+features\/demo\.feature: Gamma/);
    expect(text).not.toContain("Delta");
  }
});
