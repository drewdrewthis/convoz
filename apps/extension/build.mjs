// Builds the unpacked extension: the panel and the worker bundled by esbuild, the manifest and the page copied as they are.
// Usage: node build.mjs [out-dir]   (default dist/). The e2e suite builds into a temp dir per worker so parallel builds do not race.
import fs from "node:fs";
import path from "node:path";
import { build } from "esbuild";

const here = import.meta.dirname;
const out = path.resolve(process.argv[2] ?? path.join(here, "dist"));
fs.mkdirSync(out, { recursive: true });

await build({
  absWorkingDir: here,
  entryPoints: { sidepanel: "src/sidepanel.ts", background: "src/background.ts" },
  bundle: true,
  format: "iife",
  target: "chrome116",
  outdir: out,
  logLevel: "warning",
});
for (const file of ["manifest.json", "sidepanel.html"]) fs.copyFileSync(path.join(here, file), path.join(out, file));
