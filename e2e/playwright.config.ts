import os from "node:os";
import path from "node:path";
import { defineConfig, devices } from "@playwright/test";

const here = import.meta.dirname;

// Every scenario is one test. Retries stay at 0: a flake is a bug (docs/testing.md §8).
export default defineConfig({
  testDir: path.join(here, "tests"),
  testMatch: "**/*.spec.ts",
  outputDir: path.join(os.tmpdir(), "convoz-e2e-results"),
  // Reference frames of the prototype (tools/capture-prototype.mjs). A missing one fails the scenario; nothing rewrites them by itself.
  snapshotPathTemplate: path.join(here, "visual", "prototype", "{arg}{ext}"),
  updateSnapshots: "none",
  fullyParallel: true,
  forbidOnly: true,
  retries: 0,
  workers: os.availableParallelism(),
  timeout: 30_000,
  expect: { timeout: 5_000 },
  globalTimeout: 45 * 60_000,
  // @browser scenarios run in chromium (CDP virtual authenticator, S1a plan §4.2); everything else needs no browser.
  // The "chromium" and "headless" greps split the suite, so every scenario runs once there. "mobile" (S-U0) runs every @browser
  // scenario again as a phone (390x844, touch); @phone scenarios run ONLY there. In "mobile" the ceremony guard fails any tap
  // that starts two WebAuthn ceremonies or waits on the network before one (lib/ceremony-guard.ts, lib/fixtures.ts).
  projects: [
    { name: "headless", grepInvert: /@browser/ },
    // screenshot "on": the final screenshot of each browser scenario goes into the use-proof page (pnpm proof).
    { name: "chromium", grep: /@browser/, grepInvert: /@phone/, use: { ...devices["Desktop Chrome"], screenshot: "on" } },
    {
      name: "mobile",
      grep: /@browser/,
      use: { ...devices["Desktop Chrome"], viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3, screenshot: "on" },
    },
  ],
  reporter: [
    ["list"],
    ["json", { outputFile: path.join(here, "report", "results.json") }],
  ],
});
