import type { TestInfo } from "@playwright/test";
import { test, type Fixtures } from "./fixtures.ts";

export { test, expect } from "./fixtures.ts";
export { repoRoot, run, baseEnv, pnpmCommand, goBin } from "./run.ts";
export { convozBin } from "./fixtures.ts";

/**
 * Bind a Gherkin scenario. `title` is the verbatim scenario title; parity.py matches on it.
 * `tag` carries the driver tag (`@cli`, `@api`, `@browser`, `@mcp`) and any special tag
 * such as `@bench`. One binding per scenario; a Scenario Outline runs all its rows inside one binding.
 */
export function scenario(title: string, opts: { tag: string[] }, fn: (fx: Fixtures, info: TestInfo) => Promise<void> | void): void {
  test(title, { tag: opts.tag }, fn);
}
