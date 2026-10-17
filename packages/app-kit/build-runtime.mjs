// Builds runtime/runtime.ts into ONE minified IIFE at apps/convoz/internal/appbuild/runtime/runtime.js (embedded by the Go CLI with go:embed,
// inlined by `convoz app build` into every Tier 2 bundle). Fails over the 40 KB gzip budget.
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { build } from "vite";

const here = import.meta.dirname;
const out = path.resolve(here, "../../apps/convoz/internal/appbuild/runtime/runtime.js");
const BUDGET = 40 * 1024;

const result = await build({
  configFile: false,
  logLevel: "warn",
  build: { write: false, minify: true, target: "es2020", lib: { entry: path.join(here, "runtime/runtime.ts"), formats: ["iife"], name: "convozRuntime", fileName: "runtime" } },
});
const chunk = (Array.isArray(result) ? result[0] : result).output[0];
const code = chunk.code.trim() + "\n";
const gz = zlib.gzipSync(code).length;
if (gz > BUDGET) {
  console.error(`runtime: ${gz} B gzip is over the budget of ${BUDGET} B`);
  process.exit(1);
}
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, code);
const { KIT_VERSION } = await import("./src/kit.ts");
console.log(`runtime: ${code.length} B, ${gz} B gzip (budget ${BUDGET} B), kit ${KIT_VERSION} -> ${path.relative(process.cwd(), out)}`);
