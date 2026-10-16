import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { baseEnv, expect, goBin, pnpmCommand, repoRoot, run, scenario } from "../lib/scenario.ts";

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

// ---- S1a: module boundaries (AC-16, Go side) -------------------------------------------------------------
// Contract: `make -C apps/convoz lint-boundaries` runs the checks "go-imports" (scripts/check_go_imports.py) and
// "table-ownership" (scripts/check_table_ownership.py); each prints its check name and, per break, "<file>:<line>: <why>",
// and the target exits 1 on a break, 0 on a clean tree.

const GOMOD = "github.com/drewdrewthis/convoz/apps/convoz";

/** Copy apps/convoz (without build output) and scripts/ into a fresh dir, the way CI sees a branch. */
function copyBranch(): string {
  const root = scratch("convoz-lint-");
  const skip = (src: string) => !/(^|\/)(bin|node_modules|__pycache__)(\/|$)/.test(path.relative(repoRoot, src));
  fs.cpSync(path.join(repoRoot, "apps", "convoz"), path.join(root, "apps", "convoz"), { recursive: true, filter: skip });
  fs.cpSync(path.join(repoRoot, "scripts"), path.join(root, "scripts"), { recursive: true, filter: skip });
  return root;
}

const lint = (root: string) =>
  run("make", ["-C", path.join(root, "apps", "convoz"), "lint-boundaries", `GO=${goBin}`], { cwd: root, env: baseEnv(), timeoutMs: 60_000 });

const put = (root: string, rel: string, text: string) => {
  const file = path.join(root, "apps", "convoz", rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};

scenario("CI fails a boundary break", { tag: ["@cli"] }, async ({}, info) => {
  info.setTimeout(150_000);

  // Negative control: a clean copy of the branch passes both checks
  const clean = await lint(copyBranch());
  expect(clean.code, clean.stdout + clean.stderr).toBe(0);
  expect(clean.stdout + clean.stderr).toContain("go-imports");
  expect(clean.stdout + clean.stderr).toContain("table-ownership");

  // CI runs the target by these two step names (read from the workflow, so a step cannot be dropped silently)
  const ci = fs.readFileSync(path.join(repoRoot, ".github", "workflows", "ci.yml"), "utf8");
  expect(ci).toMatch(/name:\s*go-imports/);
  expect(ci).toMatch(/name:\s*table-ownership/);

  // Given a branch that <breaks> / When CI runs / Then the "<check>" check fails and names the file
  const rows: { breaks: string; check: string; file: string; write: (root: string) => void }[] = [
    {
      breaks: "queries a table that its Go module does not own",
      check: "table-ownership",
      file: "zz_break.sql",
      write: (r) => put(r, "internal/server/auth/queries/zz_break.sql", "-- name: ZzBreak :many\nSELECT id FROM identities;\n"),
    },
    {
      breaks: "imports internal/server from internal/cli or internal/mcp",
      check: "go-imports",
      file: "zz_break.go",
      write: (r) => put(r, "internal/cli/zz_break.go", `package cli\n\nimport _ "${GOMOD}/internal/server/crypto"\n`),
    },
    {
      breaks: "imports one server module from another",
      check: "go-imports",
      file: "zz_a.go",
      write: (r) => {
        put(r, "internal/server/auth/zz_b.go", "package auth\n");
        put(r, "internal/server/identity/zz_a.go", `package identity\n\nimport _ "${GOMOD}/internal/server/auth"\n`);
      },
    },
    {
      breaks: "calls time.Now in a server module",
      check: "go-imports",
      file: "zz_clock.go",
      write: (r) => put(r, "internal/server/identity/zz_clock.go", 'package identity\n\nimport "time"\n\nfunc zzNow() time.Time { return time.Now() }\n'),
    },
    {
      breaks: "calls time.Now through an aliased time import",
      check: "go-imports",
      file: "zz_alias.go",
      write: (r) => put(r, "internal/server/identity/zz_alias.go", 'package identity\n\nimport tm "time"\n\nfunc zzAlias() tm.Time { return tm.Now() }\n'),
    },
    {
      breaks: "reads another module's table through a comma join",
      check: "table-ownership",
      file: "zz_comma.sql",
      write: (r) => put(r, "internal/server/auth/queries/zz_comma.sql", "-- name: ZzComma :many\nSELECT p.id FROM passkeys p, identities i;\n"),
    },
    {
      breaks: "reads another module's table through a comma join after a subquery",
      check: "table-ownership",
      file: "zz_subcomma.sql",
      write: (r) => put(r, "internal/server/auth/queries/zz_subcomma.sql", "-- name: ZzSubComma :many\nSELECT p.id FROM (SELECT id FROM passkeys) p, identities i;\n"),
    },
    {
      breaks: "imports a module sqlc package from a composition root",
      check: "go-imports",
      file: "zz_dbimport.go",
      write: (r) => put(r, "internal/server/httpapi/zz_dbimport.go", `package httpapi\n\nimport _ "${GOMOD}/internal/server/auth/db"\n`),
    },
    {
      breaks: "holds SQL in a composition root",
      check: "table-ownership",
      file: "zz_sql.go",
      write: (r) => put(r, "internal/server/httpapi/zz_sql.go", 'package httpapi\n\nconst zzSQL = "SELECT id FROM passkeys"\n'),
    },
  ];
  for (const row of rows) {
    const root = copyBranch();
    row.write(root);
    const res = await lint(root);
    const out = res.stdout + res.stderr;
    expect(res.code, `${row.breaks}: ${out}`).toBe(1);
    expect(out, row.breaks).toContain(row.check);
    expect(out, row.breaks).toContain(row.file);
  }
});

// ---- S1a: AC-1 red first, green at head ------------------------------------------------------------------
// Contract: `python3 -I scripts/red_green.py <base> <head> [--runner PATH]`, run inside a git repo.
//  - The test-only commit is the first commit in base..head that touches only e2e/ and specs/.
//  - The slice is the set of scenario titles that lose @unimplemented between base and head.
//  - It calls `PATH <worktree-dir> <title>...` once for the test-only commit and once for head, each in a
//    checkout of that commit; the runner prints JSON {"<title>": "passed" | "failed"}. (CI's default runner builds
//    the testhooks binary there and runs Playwright with the titles.)
//  - Every title must be "failed" on the test-only commit and "passed" at head. Exit 0 and print
//    "test-only commit: <sha>", "red: <title>" and "green: <title>". Else exit 1 and print "FAIL: <title>: <why>"
//    ("passed on the test-only commit" | "failed at head") or "FAIL: no test-only commit".

const demoFeature = (tag: string) =>
  [
    "Feature: Demo TESTONLY",
    "",
    `  @v1 @cli${tag}`,
    "  Scenario: Alpha",
    "    When a",
    "    Then b",
    "",
    `  @v1 @api${tag}`,
    "  Scenario: Beta",
    "    When a",
    "    Then b",
    "",
    "  @v1 @cli",
    "  Scenario: Gamma",
    "    When a",
    "    Then b",
    "",
  ].join("\n");

async function sliceRepo(layout: "red-then-green" | "already-green" | "mixed") {
  const repo = scratch("convoz-rg-");
  const home = scratch("convoz-home-");
  const git = (...args: string[]) =>
    run("git", ["-c", "commit.gpgsign=false", "-c", "user.name=TESTONLY", "-c", "user.email=testonly@example.invalid", "-c", "init.defaultBranch=main", ...args], {
      cwd: repo,
      env: baseEnv({ HOME: home, GIT_CONFIG_NOSYSTEM: "1" }),
    });
  const write = (rel: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
    fs.writeFileSync(path.join(repo, rel), text);
  };
  const commit = async (msg: string) => {
    expect((await git("add", "-A")).code).toBe(0);
    expect((await git("commit", "-q", "-m", msg)).code).toBe(0);
  };
  expect((await git("init", "-q")).code).toBe(0);
  write("specs/features/demo.feature", demoFeature(" @unimplemented"));
  write("specs/contracts/.keep", "");
  if (layout === "already-green") write("src/feature.txt", "the feature is already here\n");
  await commit("base");
  write("specs/features/demo.feature", demoFeature(""));
  write("e2e/tests/demo.spec.ts", "// TESTONLY bindings for Alpha and Beta\n");
  if (layout === "mixed") write("src/feature.txt", "code in the test commit\n");
  await commit("test-only");
  if (layout === "red-then-green") {
    write("src/feature.txt", "the feature\n");
    await commit("code");
  }
  const runner = path.join(scratch("convoz-runner-"), "runner");
  fs.writeFileSync(
    runner,
    `#!${process.execPath}\n` +
      'const fs = require("fs"); const path = require("path");\n' +
      "const [dir, ...titles] = process.argv.slice(2);\n" +
      'const ok = fs.existsSync(path.join(dir, "src", "feature.txt"));\n' +
      'const out = {}; for (const t of titles) out[t] = ok ? "passed" : "failed";\n' +
      "process.stdout.write(JSON.stringify(out) + String.fromCharCode(10));\n",
    { mode: 0o755 },
  );
  fs.chmodSync(runner, 0o755);
  const rev = async (r: string) => (await git("rev-parse", r)).stdout.trim();
  const head = await rev("HEAD");
  const base = await rev(layout === "red-then-green" ? "HEAD~2" : "HEAD~1");
  const testOnly = await rev(layout === "red-then-green" ? "HEAD~1" : "HEAD");
  const res = await py(path.join(repoRoot, "scripts/red_green.py"), [base, head, "--runner", runner], { cwd: repo, env: { HOME: home }, timeoutMs: 30_000 });
  return { res, testOnly };
}

scenario("A slice PR shows its scenarios red first and green at head", { tag: ["@cli"] }, async ({}, info) => {
  info.setTimeout(90_000);

  // Given a slice PR with a test-only commit followed by code commits
  // When CI runs the slice's tagged scenarios on the test-only commit and on head
  const good = await sliceRepo("red-then-green");

  // Then every scenario of the slice fails on the test-only commit, and passes on head
  expect(good.res.code, good.res.stdout + good.res.stderr).toBe(0);
  expect(good.res.stdout).toContain(`test-only commit: ${good.testOnly}`);
  for (const title of ["Alpha", "Beta"]) {
    expect(good.res.stdout).toContain(`red: ${title}`);
    expect(good.res.stdout).toContain(`green: ${title}`);
  }
  expect(good.res.stdout).not.toContain("Gamma"); // it did not lose @unimplemented: not in the slice

  // And a scenario that already passes on the test-only commit fails the step, named
  const already = await sliceRepo("already-green");
  expect(already.res.code).toBe(1);
  expect(already.res.stdout).toContain("FAIL: Alpha: passed on the test-only commit");
  expect(already.res.stdout).toContain("FAIL: Beta: passed on the test-only commit");

  // And a PR with no test-only commit fails the step
  const mixed = await sliceRepo("mixed");
  expect(mixed.res.code).toBe(1);
  expect(mixed.res.stdout).toContain("FAIL: no test-only commit");
});
