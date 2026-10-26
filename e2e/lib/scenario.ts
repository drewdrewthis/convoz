import type { PlaywrightTestArgs, TestInfo } from "@playwright/test";
import { test, type Fixtures } from "./fixtures.ts";

export { test, expect } from "./fixtures.ts";
export { serveDefaults, supportsS1aFlags } from "./fixtures.ts";
export { repoRoot, run, baseEnv, pnpmCommand, goBin } from "./run.ts";
export { convozBin } from "./fixtures.ts";

/**
 * Bind a Gherkin scenario. `title` is the verbatim scenario title; parity.py matches on it.
 * `tag` carries the driver tag (`@cli`, `@api`, `@browser`, `@mcp`) and any special tag
 * such as `@bench`. One binding per scenario; a Scenario Outline runs all its rows inside one binding.
 */
// opts.fixme: the issue URL for a known product bug; the scenario is skipped (test.fixme) until that issue is fixed.
export function scenario(title: string, opts: { tag: string[]; fixme?: string }, fn: (fx: Fixtures & PlaywrightTestArgs, info: TestInfo) => Promise<void> | void): void {
  if (opts.fixme) test.fixme(title, { tag: opts.tag }, fn);
  else test(title, { tag: opts.tag }, fn);
}
