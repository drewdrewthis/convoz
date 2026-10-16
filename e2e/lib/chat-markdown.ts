import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { repoRoot } from "./paths.ts";

const chatJs = path.join(repoRoot, "apps/convoz/internal/server/console/static/chat.js");

/**
 * loadRenderMarkdown evaluates the real "safe markdown" section of chat.js in plain Node, with a stub for the console's el().
 * Chromium's V8 falls back to a linear regex engine on heavy backtracking, so a browser timing cannot catch a slow regex;
 * iPhone Safari has no such fallback. Node's V8 backtracks for real, so timing here is the honest guard.
 */
export function loadRenderMarkdown(): (source: string) => unknown {
  const text = fs.readFileSync(chatJs, "utf8");
  const from = text.indexOf("// ---- safe markdown");
  const to = text.indexOf("// ---- a conversation");
  if (from < 0 || to < from) throw new Error("chat.js section markers moved");
  const el = (tag: string, attrs: unknown, ...kids: unknown[]) => {
    const node = { tag, attrs, kids, append: (...more: unknown[]) => void kids.push(...more) };
    return node;
  };
  const make = vm.runInNewContext(`(function (el, URL) { ${text.slice(from, to)}\n return renderMarkdown; })`);
  return make(el, URL);
}
