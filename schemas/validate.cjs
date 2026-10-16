// Validates every schema (ajv strict compile, draft 2020-12) and every example in examples/.
// ajv is loaded from the given node_modules dir because npx is not on PATH here.
// Usage: node validate.cjs <node_modules dir> <schemas dir>
"use strict";
const path = require("path");
const fs = require("fs");
const [nm, dir] = process.argv.slice(2);
const Ajv2020 = require(path.join(nm, "ajv/dist/2020.js")).default;
const ajvVersion = require(path.join(nm, "ajv/package.json")).version;

const files = ["common.json", "app.json", "manifest.json", "bridge.json", "app-result.json", "system.json"]
  .concat(fs.readdirSync(path.join(dir, "components")).map((f) => "components/" + f));
const ajv = new Ajv2020({ strict: true, strictRequired: false, allErrors: true });
const ids = {};
for (const f of files) {
  const s = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
  ajv.addSchema(s);
  ids[f] = s.$id;
}
let fail = 0;
for (const f of files) {
  try {
    ajv.getSchema(ids[f]);
    ajv.compile({ $ref: ids[f] });
    console.log("SCHEMA ok      " + f);
  } catch (e) {
    fail++;
    console.log("SCHEMA BROKEN  " + f + ": " + e.message);
  }
}
const run = (kind, wantValid) => {
  const list = JSON.parse(fs.readFileSync(path.join(dir, "examples", kind + ".json"), "utf8"));
  for (const ex of list) {
    const v = ex.ref ? ajv.getSchema(ids[ex.ref.split("#")[0]] + "#" + ex.ref.split("#")[1]) : ajv.getSchema(ids[ex.schema]);
    const ok = v(ex.data);
    const bytes = Buffer.byteLength(JSON.stringify(ex.data));
    const firstErr = ok ? "" : (v.errors[0].instancePath || "/") + " " + v.errors[0].message;
    const good = ok === wantValid && (!wantValid || ex.schema !== "app.json" || bytes <= 65536);
    if (!good) fail++;
    console.log((good ? "PASS " : "FAIL ") + kind.padEnd(7) + ex.schema.padEnd(16) + (ex.name + (ex.ref ? " @" + ex.ref.split("#")[1] : "")).padEnd(58) + bytes + " B" + (firstErr ? "  [" + firstErr + "]" : ""));
  }
  return list.length;
};
const nv = run("valid", true);
const ni = run("invalid", false);
console.log("ajv " + ajvVersion + " (draft 2020-12, strict). schemas=" + files.length + " valid=" + nv + " invalid=" + ni + " failures=" + fail);
process.exit(fail ? 1 : 0);
