import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildCatalogue, axeSource, serveFolder } from "../lib/quality-wp18.ts";
import { baseEnv, expect, repoRoot, run, scenario } from "../lib/scenario.ts";

/*
 * QUALITY GATES (WP18): "Every ui story passes axe in every theme and size" (AC-17) and "A budget miss or a 20 percent regression
 * blocks the slice" (AC-9). The p95 scenario on the 1M fixture is not bound here: it needs the target VM (see the report of WP18).
 */

const PALETTES = ["iris", "ember", "tide", "mono"];
const THEMES = ["light", "dark"];
const SIZES = [
  { width: 390, height: 844 },
  { width: 1280, height: 940 },
];

scenario("Every ui story passes axe in every theme and size", { tag: ["@browser"] }, async ({ page }, info) => {
  info.setTimeout(180_000);
  const catalogue = await buildCatalogue();
  const site = await serveFolder(catalogue.dir);
  const shots = fs.mkdtempSync(path.join(os.tmpdir(), "convoz-axe-shots-"));
  try {
    // When the Ladle stories run in Playwright in light and dark, for each palette, at 390x844 and 1280x940
    const axe = axeSource();
    const violations: string[] = [];
    const taken: string[] = [];
    for (const story of catalogue.stories) {
      for (const size of SIZES) {
        await page.setViewportSize(size);
        await page.goto(`${site.origin}/?story=${story}&mode=preview`);
        await page.locator("#ladle-root *").first().waitFor();
        await page.addScriptTag({ content: axe });
        for (const palette of PALETTES) {
          for (const theme of THEMES) {
            await page.evaluate(
              ([p, t]) => {
                document.documentElement.setAttribute("data-palette", p!);
                document.documentElement.setAttribute("data-theme", t!);
              },
              [palette, theme],
            );
            const found = await page.evaluate(async () => {
              const result = await (window as unknown as { axe: { run: () => Promise<{ violations: { id: string; nodes: { target: unknown[] }[] }[] }> } }).axe.run();
              return result.violations.map((v) => `${v.id} on ${v.nodes.map((n) => String(n.target)).join(" | ")}`);
            });
            for (const v of found) violations.push(`${story} ${palette} ${theme} ${size.width}x${size.height}: ${v}`);
            const shot = path.join(shots, `${story}.${palette}.${theme}.${size.width}x${size.height}.png`);
            await page.locator("#ladle-root").screenshot({ path: shot });
            taken.push(path.basename(shot));
          }
        }
      }
    }

    // Then axe reports 0 violations for every story
    expect(catalogue.stories.length, "the catalogue lists the stories of packages/ui").toBeGreaterThan(0);
    expect(violations).toEqual([]);

    // And each story has a screenshot for each combination
    const want = catalogue.stories.flatMap((s) => SIZES.flatMap((z) => PALETTES.flatMap((p) => THEMES.map((t) => `${s}.${p}.${t}.${z.width}x${z.height}.png`))));
    const onDisk = fs.readdirSync(shots).filter((f) => fs.statSync(path.join(shots, f)).size > 0);
    expect(onDisk.sort()).toEqual(want.sort());
    for (const f of taken.filter((_, i) => i % 16 === 0)) await info.attach(f, { path: path.join(shots, f), contentType: "image/png" });
  } finally {
    await site.close();
  }
});

// ---- the benchmark gate (AC-9) ---------------------------------------------------------------------------

const GATE = path.join(repoRoot, "scripts", "bench_gate.py");
const FEATURE = path.join(repoRoot, "specs", "contracts", "quality-gates.feature");

/** The budgets of the p95 Outline in the feature file: `| BenchmarkNow | 8 ms |`. */
function budgetsOfFeature(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const m of fs.readFileSync(FEATURE, "utf8").matchAll(/^\s*\|\s*(Benchmark\w+)\s*\|\s*(\d+)\s*ms\s*\|/gm)) out[m[1]!] = Number(m[2]);
  return out;
}

/** `go test -bench` output with a p95 per benchmark, each run three times. */
function results(p95: Record<string, number>): string {
  const lines = ["goos: linux", "goarch: amd64", "pkg: github.com/drewdrewthis/convoz/apps/convoz/bench"];
  for (const [name, ms] of Object.entries(p95)) for (let i = 0; i < 3; i++) lines.push(`${name}-8\t1\t${Math.round(ms * 1e6)} ns/op\t${ms} p95-ms`);
  return lines.join("\n") + "\n";
}

scenario("A budget miss or a 20 percent regression blocks the slice", { tag: ["@cli"] }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "convoz-benchgate-"));
  const gate = async (now: Record<string, number>, main: Record<string, number>) => {
    fs.writeFileSync(path.join(dir, "now.txt"), results(now));
    fs.writeFileSync(path.join(dir, "main.txt"), results(main));
    return run("python3", ["-I", GATE, path.join(dir, "now.txt"), "--base", path.join(dir, "main.txt")], { env: baseEnv(), timeoutMs: 20_000 });
  };
  const budgets = budgetsOfFeature();
  expect(Object.keys(budgets), "the feature lists the 12 benchmarks").toHaveLength(12);
  const half = Object.fromEntries(Object.entries(budgets).map(([k, v]) => [k, v / 2]));
  const budgetFile = JSON.parse(fs.readFileSync(path.join(repoRoot, "scripts", "bench_budgets.json"), "utf8")) as Record<string, unknown>;
  const gated = Object.fromEntries(Object.entries(budgetFile).filter(([k]) => k.startsWith("Benchmark")));
  expect(gated, "the gate and the feature carry the same budgets").toEqual(budgets);

  // Control: results inside every budget and as fast as main are READY
  const clean = await gate(half, half);
  expect(clean.code, clean.stdout + clean.stderr).toBe(0);
  expect(clean.stdout.trim().split("\n").pop()).toBe("READY");

  // Given a benchmark result over budget; When CI compares it with benchstat; Then the slice is marked NOT READY
  const over = await gate({ ...half, BenchmarkNow: budgets.BenchmarkNow! + 0.5 }, { ...half, BenchmarkNow: budgets.BenchmarkNow! + 0.5 });
  expect(over.code).toBe(1);
  expect(over.stdout).toContain("BenchmarkNow: over budget");
  expect(over.stdout.trim().split("\n").pop()).toBe("NOT READY");

  // Given a benchmark result 20 percent slower than main (still inside its budget)
  const slower = await gate({ ...half, BenchmarkBrief: half.BenchmarkBrief! * 1.25 }, half);
  expect(slower.code).toBe(1);
  expect(slower.stdout).toContain("BenchmarkBrief: regression");
  expect(slower.stdout.trim().split("\n").pop()).toBe("NOT READY");

  // Control: 15 percent slower is inside the line
  const near = await gate({ ...half, BenchmarkBrief: half.BenchmarkBrief! * 1.15 }, half);
  expect(near.code, near.stdout).toBe(0);

  // A benchmark that did not run has not met its budget
  const { BenchmarkFanout: _gone, ...fewer } = half;
  const missing = await gate(fewer, half);
  expect(missing.code).toBe(1);
  expect(missing.stdout).toContain("BenchmarkFanout: no result");
});
