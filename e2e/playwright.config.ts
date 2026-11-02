import os from "node:os";
import path from "node:path";
import { defineConfig, devices } from "@playwright/test";

const here = import.meta.dirname;
const PERF = "**/*.perf.spec.ts";
const phone = { ...devices["Desktop Chrome"], viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3, screenshot: "on" as const };

// Every scenario is one test. Retries stay at 0: a flake is a bug (docs/testing.md §8).
export default defineConfig({
  testDir: path.join(here, "tests"),
  testMatch: "**/*.spec.ts",
  outputDir: path.join(os.tmpdir(), "convoz-e2e-results"),
  // Reference frames of the prototype (tools/capture-prototype.mjs). A missing one fails the scenario; nothing rewrites them by itself.
  snapshotPathTemplate: path.join(here, "visual", "{arg}{ext}"),
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
  // "perf" measures the client's time budget (design §12.2), and a budget measured while other browsers load the box measures the box. It is
  // the teardown of "alone", which every other project depends on, so it starts when they have all finished (a teardown runs even when a
  // scenario failed; a plain dependency would skip the budget and hide a red row) and nothing runs beside it. The full run (`pnpm e2e`)
  // sets CONVOZ_PERF=1; a targeted `playwright test -g …` does not wait on the budget, and `--project=perf` still runs it alone.
  projects: [
    { name: "alone", testMatch: /^$/, ...(process.env.CONVOZ_PERF === "1" ? { teardown: "perf" } : {}) },
    { name: "headless", grepInvert: /@browser/, dependencies: ["alone"] },
    // screenshot "on": the final screenshot of each browser scenario goes into the use-proof page (pnpm proof).
    { name: "chromium", grep: /@browser/, grepInvert: /@phone/, use: { ...devices["Desktop Chrome"], screenshot: "on" }, dependencies: ["alone"] },
    // The browser extension (browser-extension.spec.ts, page-share.spec.ts) is desktop Chrome only: it launches its own Chromium with the extension.
    { name: "mobile", grep: /@browser/, testIgnore: [PERF, "**/browser-extension.spec.ts", "**/page-share.spec.ts"], use: phone, dependencies: ["alone"] },
    // The perf scenario reaches the server through a TLS front with a throwaway self-signed cert (lib/h2-front.ts). ignoreHTTPSErrors alone
    // does not cover the service worker's script fetch, so the browser itself is told to accept it (this project's browser only).
    { name: "perf", grep: /@browser/, testMatch: PERF, use: { ...phone, launchOptions: { args: ["--ignore-certificate-errors"] } } },
  ],
  reporter: [
    ["list"],
    ["json", { outputFile: path.join(here, "report", "results.json") }],
  ],
});
