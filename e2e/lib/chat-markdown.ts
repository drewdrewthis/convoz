import vm from "node:vm";
import { createRenderer } from "../../packages/markdown/src/index.ts";

/**
 * loadRenderMarkdown runs the web app's real "safe markdown" renderer (packages/markdown, the module the page bundles) in plain Node.
 * Chromium's V8 falls back to a linear regex engine on heavy backtracking, so a browser timing cannot catch a slow regex;
 * iPhone Safari has no such fallback. Node's V8 backtracks for real, so timing here is the honest guard.
 * The lookalike-punctuation set is fetched from the running server's /assets/lookalikes.js, the same bytes the page gets,
 * so the Go table stays its only owner. The renderer returns a plain tree of {tag, attrs, kids}.
 */
export async function loadRenderMarkdown(origin: string, options: { withLookalikes?: boolean } = {}): Promise<(source: string) => unknown> {
  // withLookalikes: false loads no asset, like a page whose /assets/lookalikes.js failed to load
  if (options.withLookalikes === false) return createRenderer(null);
  const asset = await (await fetch(`${origin}/assets/lookalikes.js`)).text();
  const context = vm.createContext({});
  vm.runInContext(asset, context);
  const set = (context as { CONVOZ_LOOKALIKES?: unknown }).CONVOZ_LOOKALIKES;
  return createRenderer(typeof set === "string" ? set : null);
}
