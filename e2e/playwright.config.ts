import os from "node:os";
import path from "node:path";
import { defineConfig } from "@playwright/test";

const here = import.meta.dirname;

// Every scenario is one test. Retries stay at 0: a flake is a bug (docs/testing.md §8).
export default defineConfig({
  testDir: path.join(here, "tests"),
  testMatch: "**/*.spec.ts",
  outputDir: path.join(os.tmpdir(), "convoz-e2e-results"),
  fullyParallel: true,
  forbidOnly: true,
  retries: 0,
  workers: os.availableParallelism(),
  timeout: 30_000,
  expect: { timeout: 5_000 },
  globalTimeout: 45 * 60_000,
  reporter: [
    ["list"],
    ["json", { outputFile: path.join(here, "report", "results.json") }],
  ],
});
