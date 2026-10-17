// The web app's validator of apps, results and bridge messages. It reads the same schemas/ files as the Go validator
// (apps/convoz/internal/appschema) and reports the first failure the same way: a code, a JSON pointer, a rule and words.
// A small interpreter instead of ajv: ajv builds code with `new Function`, which the page CSP (no unsafe-eval) forbids.
import appResult from "../../../schemas/app-result.json" with { type: "json" };
import app from "../../../schemas/app.json" with { type: "json" };
import bridge from "../../../schemas/bridge.json" with { type: "json" };
import common from "../../../schemas/common.json" with { type: "json" };
import chart from "../../../schemas/components/chart.json" with { type: "json" };
import checklist from "../../../schemas/components/checklist.json" with { type: "json" };
import code from "../../../schemas/components/code.json" with { type: "json" };
import form from "../../../schemas/components/form.json" with { type: "json" };
import frame from "../../../schemas/components/frame.json" with { type: "json" };
import gallery from "../../../schemas/components/gallery.json" with { type: "json" };
import kv from "../../../schemas/components/kv.json" with { type: "json" };
import picker from "../../../schemas/components/picker.json" with { type: "json" };
import progress from "../../../schemas/components/progress.json" with { type: "json" };
import table from "../../../schemas/components/table.json" with { type: "json" };
import manifest from "../../../schemas/manifest.json" with { type: "json" };

/** The outcome of a check. `code` is `app_invalid`, `app_semantic`, `app_too_large`, `app_result_invalid`, `app_result_not_allowed` or `bridge_invalid`. */
export type Verdict = { ok: true } | { ok: false; code: string; path: string; rule: string; message: string };
type Issue = { path: string; rule: string; message: string };
type Json = unknown;
type Schema = boolean | { [key: string]: Json };

const MAX_APP = 65536;
const MAX_FRAME_DATA = 32768;
const MAX_RESULT = 4096;
const MAX_BRIDGE = 8192;

const documents = new Map<string, Schema>();
for (const d of [app, appResult, bridge, common, manifest, chart, checklist, code, form, frame, gallery, kv, picker, progress, table]) {
  documents.set((d as { $id: string }).$id, d as Schema);
}

const esc = (key: string) => key.replace(/~/g, "~0").replace(/\//g, "~1");
const typeOf = (v: Json) => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v);
const isObject = (v: Json): v is Record<string, Json> => typeOf(v) === "object";
const chars = (s: string) => [...s].length;
const plural = (n: number, word: string) => (n === 1 ? word : word + "s");
const sameJson = (a: Json, b: Json) => JSON.stringify(a) === JSON.stringify(b);

function resolve(ref: string, base: string): { schema: Schema; base: string } {
  const url = new URL(ref, base);
  const doc = url.hash ? url.href.slice(0, url.href.length - url.hash.length) : url.href;
  let node: Json = documents.get(doc);
  for (const part of decodeURIComponent(url.hash.slice(1)).split("/").filter(Boolean)) {
    node = (node as Record<string, Json>)[part.replace(/~1/g, "/").replace(/~0/g, "~")];
  }
  return { schema: node as Schema, base: doc };
}

function typeMatches(want: string, v: Json): boolean {
  if (want === "integer") return typeof v === "number" && Number.isInteger(v);
  if (want === "number") return typeof v === "number";
  return typeOf(v) === want;
}

function compile(pattern: string): RegExp {
  try {
    return new RegExp(pattern, "u");
  } catch {
    return new RegExp(pattern);
  }
}

/** Every failure under `schema`, in the order the keywords run. An anyOf, oneOf, not or propertyNames failure is one issue at its place. */
function walk(schema: Schema, v: Json, path: string, base: string, out: Issue[]): void {
  if (schema === true) return;
  const at = (key: string | number) => `${path}/${esc(String(key))}`;
  if (schema === false) {
    out.push({ path, rule: "falseSchema", message: "is not allowed here" });
    return;
  }
  if (typeof schema.$ref === "string") {
    const r = resolve(schema.$ref, base);
    walk(r.schema, v, path, r.base, out);
  }
  if (schema.type !== undefined) {
    const want = (Array.isArray(schema.type) ? schema.type : [schema.type]) as string[];
    if (!want.some((t) => typeMatches(t, v))) {
      const t = want.join(" or ");
      out.push({ path, rule: "type", message: "must be " + (/^[aeiou]/.test(t) ? "an " : "a ") + t });
    }
  }
  if ("const" in schema && !sameJson(schema.const, v)) out.push({ path, rule: "const", message: "must be " + String(schema.const) });
  if (Array.isArray(schema.enum) && !schema.enum.some((e) => sameJson(e, v))) {
    out.push({ path, rule: "enum", message: "must be one of: " + schema.enum.join(", ") });
  }
  if (typeof v === "string") stringRules(schema, v, path, out);
  if (typeof v === "number") numberRules(schema, v, path, out);
  if (Array.isArray(v)) arrayRules(schema, v, path, base, out, at);
  if (isObject(v)) objectRules(schema, v, path, base, out, at);
  for (const s of (schema.allOf as Schema[] | undefined) ?? []) walk(s, v, path, base, out);
  if (Array.isArray(schema.anyOf) && !schema.anyOf.some((s) => ok(s as Schema, v, base))) {
    out.push({ path, rule: "anyOf", message: "does not match any allowed shape" });
  }
  if (Array.isArray(schema.oneOf) && schema.oneOf.filter((s) => ok(s as Schema, v, base)).length !== 1) {
    out.push({ path, rule: "oneOf", message: "does not match any allowed shape" });
  }
  if (schema.not !== undefined && ok(schema.not as Schema, v, base)) {
    out.push({ path, rule: "not", message: "these keys cannot be used together" });
  }
  if (schema.if !== undefined) {
    const branch = ok(schema.if as Schema, v, base) ? schema.then : schema.else;
    if (branch !== undefined) walk(branch as Schema, v, path, base, out);
  }
}

function ok(schema: Schema, v: Json, base: string): boolean {
  const out: Issue[] = [];
  walk(schema, v, "", base, out);
  return out.length === 0;
}

function stringRules(schema: Record<string, Json>, v: string, path: string, out: Issue[]) {
  const n = chars(v);
  if (typeof schema.minLength === "number" && n < schema.minLength) {
    out.push({ path, rule: "minLength", message: `must have at least ${schema.minLength} ${plural(schema.minLength, "character")}` });
  }
  if (typeof schema.maxLength === "number" && n > schema.maxLength) {
    out.push({ path, rule: "maxLength", message: `must have at most ${schema.maxLength} ${plural(schema.maxLength, "character")}` });
  }
  if (typeof schema.pattern === "string" && !compile(schema.pattern).test(v)) out.push({ path, rule: "pattern", message: "has the wrong format" });
}

function numberRules(schema: Record<string, Json>, v: number, path: string, out: Issue[]) {
  if (typeof schema.minimum === "number" && v < schema.minimum) out.push({ path, rule: "minimum", message: `must be at least ${schema.minimum}` });
  if (typeof schema.maximum === "number" && v > schema.maximum) out.push({ path, rule: "maximum", message: `must be at most ${schema.maximum}` });
  if (typeof schema.exclusiveMinimum === "number" && v <= schema.exclusiveMinimum) {
    out.push({ path, rule: "exclusiveMinimum", message: `must be more than ${schema.exclusiveMinimum}` });
  }
}

function arrayRules(schema: Record<string, Json>, v: Json[], path: string, base: string, out: Issue[], at: (k: string | number) => string) {
  if (typeof schema.minItems === "number" && v.length < schema.minItems) {
    out.push({ path, rule: "minItems", message: `must have at least ${schema.minItems} ${plural(schema.minItems, "item")}` });
  }
  if (typeof schema.maxItems === "number" && v.length > schema.maxItems) {
    out.push({ path, rule: "maxItems", message: `must have at most ${schema.maxItems} ${plural(schema.maxItems, "item")}` });
  }
  if (schema.uniqueItems === true && v.some((a, i) => v.findIndex((b) => sameJson(a, b)) !== i)) {
    out.push({ path, rule: "uniqueItems", message: "items must be different" });
  }
  if (schema.items !== undefined) v.forEach((item, i) => walk(schema.items as Schema, item, at(i), base, out));
}

function objectRules(schema: Record<string, Json>, v: Record<string, Json>, path: string, base: string, out: Issue[], at: (k: string | number) => string) {
  const missing = ((schema.required as string[] | undefined) ?? []).filter((k) => !(k in v)).sort();
  for (const k of missing) out.push({ path: at(k), rule: "required", message: "is required" });
  if (typeof schema.maxProperties === "number" && Object.keys(v).length > schema.maxProperties) {
    out.push({ path, rule: "maxProperties", message: `must have at most ${schema.maxProperties} ${plural(schema.maxProperties, "key")}` });
  }
  if (schema.propertyNames !== undefined) {
    for (const k of Object.keys(v).sort()) {
      if (!ok(schema.propertyNames as Schema, k, base)) out.push({ path: at(k), rule: "propertyNames", message: "key has the wrong format" });
    }
  }
  const props = (schema.properties ?? {}) as Record<string, Schema>;
  for (const k of Object.keys(props).sort()) if (k in v) walk(props[k]!, v[k], at(k), base, out);
  if (schema.additionalProperties !== undefined) {
    for (const k of Object.keys(v).sort()) {
      if (k in props) continue;
      if (schema.additionalProperties === false) out.push({ path: at(k), rule: "additionalProperties", message: "unknown key" });
      else walk(schema.additionalProperties as Schema, v[k], at(k), base, out);
    }
  }
  const dep = (schema.dependentRequired ?? {}) as Record<string, string[]>;
  for (const [prop, needs] of Object.entries(dep)) {
    if (prop in v) for (const n of [...needs].sort()) if (!(n in v)) out.push({ path: at(n), rule: "dependentRequired", message: `is required with ${prop}` });
  }
}

/** The one issue that is reported: the shortest path, then the alphabetically first, then the order found. */
function first(issues: Issue[]): Issue | undefined {
  return issues
    .map((issue, order) => ({ issue, order }))
    .sort((a, b) => a.issue.path.length - b.issue.path.length || (a.issue.path < b.issue.path ? -1 : a.issue.path > b.issue.path ? 1 : 0) || a.order - b.order)[0]?.issue;
}

function schemaCheck(ref: string, value: Json, code: string): Verdict {
  const r = resolve(ref, "https://schemas.convoz.dev/v1/");
  const issues: Issue[] = [];
  walk(r.schema, value, "", r.base, issues);
  const f = first(issues);
  return f ? { ok: false, code, ...f } : { ok: true };
}

const fail = (code: string, path: string, rule: string, message: string): Verdict => ({ ok: false, code, path, rule, message });
const semantic = (path: string, rule: string, message: string) => fail("app_semantic", path, rule, message);
const bytes = (v: Json) => new TextEncoder().encode(JSON.stringify(v)).length;

type Obj = Record<string, any>;

/** Checks an app (schemas/app.json) and its semantic rules. */
export function validateApp(value: unknown): Verdict {
  if (bytes(value) > MAX_APP) return fail("app_too_large", "", "size", `must have at most ${MAX_APP} bytes`);
  const v = schemaCheck("app.json", value, "app_invalid");
  if (!v.ok) return v;
  return appSemantic(value as Obj);
}

function duplicate(items: { id: string }[], base: string): Verdict | undefined {
  const seen = new Set<string>();
  for (const [i, it] of items.entries()) {
    if (seen.has(it.id)) return semantic(`${base}/${i}/id`, "duplicate_id", "id is used twice");
    seen.add(it.id);
  }
  return undefined;
}

function appSemantic(a: Obj): Verdict {
  const p: Obj = a.props;
  switch (a.type) {
    case "chart": {
      if (p.x) {
        for (const [i, s] of (p.series as Obj[]).entries()) {
          if (s.values.length !== p.x.labels.length) return semantic(`/props/series/${i}/values`, "lengths_mismatch", "must have as many values as x has labels");
        }
      }
      if (p.y && p.y.min !== undefined && p.y.max !== undefined && p.y.min >= p.y.max) return semantic("/props/y/max", "range", "must be more than min");
      break;
    }
    case "table": {
      for (const [i, r] of (p.rows as Json[][]).entries()) if (r.length !== p.columns.length) return semantic(`/props/rows/${i}`, "row_width", "must have one cell per column");
      if (p.highlightRow !== undefined && p.highlightRow >= p.rows.length) return semantic("/props/highlightRow", "highlight_row", "must be a row of the table");
      break;
    }
    case "checklist": {
      const d = duplicate(p.items, "/props/items");
      if (d) return d;
      if (p.minChecked !== undefined && p.minChecked > p.items.length) return semantic("/props/minChecked", "min_checked", "must not be more than the number of items");
      break;
    }
    case "picker": {
      const d = duplicate(p.options, "/props/options");
      if (d) return d;
      const lo = p.min ?? 1;
      const hi = p.max ?? p.options.length;
      if (p.max !== undefined && p.max > p.options.length) return semantic("/props/max", "max_options", "must not be more than the number of options");
      if (lo > hi) return semantic("/props/max", "min_max", "must not be less than min");
      break;
    }
    case "form": {
      const d = duplicate(p.fields, "/props/fields");
      if (d) return d;
      for (const [i, f] of (p.fields as Obj[]).entries()) {
        if (f.kind === "select" && typeof f.default === "string" && !(f.options as Obj[]).some((o) => o.id === f.default)) {
          return semantic(`/props/fields/${i}/default`, "select_default", "must be one of the option ids");
        }
        if (f.min !== undefined && f.max !== undefined && f.min > f.max) return semantic(`/props/fields/${i}/max`, "min_max", "must not be less than min");
      }
      break;
    }
    case "progress":
      if (p.done !== undefined && p.total !== undefined && p.done > p.total) return semantic("/props/done", "done_over_total", "must not be more than total");
      break;
    case "code":
      if (p.text.split("\n").length > 2000) return semantic("/props/text", "too_many_lines", "must have at most 2000 lines");
      break;
    case "frame":
      if (p.data !== undefined && bytes(p.data) > MAX_FRAME_DATA) return fail("app_too_large", "/props/data", "size", `must have at most ${MAX_FRAME_DATA} bytes`);
      break;
  }
  return { ok: true };
}

const bad = (path: string, rule: string, message: string) => fail("app_result_invalid", path, rule, message);

/** Checks a result (schemas/app-result.json) against the app it answers. */
export function validateResult(appValue: unknown, result: unknown): Verdict {
  if (bytes(result) > MAX_RESULT) return bad("", "size", `must have at most ${MAX_RESULT} bytes`);
  const v = schemaCheck("app-result.json", result, "app_result_invalid");
  if (!v.ok) return v;
  const a = appValue as Obj;
  const r = result as Obj;
  if (r.source !== a.type) return bad("/source", "source", "must be the type of the app");
  const p: Obj = a.props;
  switch (a.type) {
    case "picker": {
      const sel = r.value.selected as string[];
      for (const [k, id] of sel.entries()) if (!(p.options as Obj[]).some((o) => o.id === id)) return bad(`/value/selected/${k}`, "option", "is not an option of the picker");
      const lo = p.multi ? (p.min ?? 1) : 1;
      const hi = p.multi ? (p.max ?? p.options.length) : 1;
      if (sel.length < lo || sel.length > hi) return bad("/value/selected", "count", `must have ${lo} to ${hi} choices`);
      return { ok: true };
    }
    case "checklist": {
      if (p.mode !== "select") return fail("app_result_not_allowed", "/source", "mode", "this checklist is read only");
      const checked = r.value.checked as string[];
      for (const [k, id] of checked.entries()) if (!(p.items as Obj[]).some((o) => o.id === id)) return bad(`/value/checked/${k}`, "item", "is not an item of the checklist");
      if (checked.length < (p.minChecked ?? 0)) return bad("/value/checked", "min_checked", `must have at least ${p.minChecked} checks`);
      return { ok: true };
    }
    case "form":
      return formResult(p, r.value.fields as Obj);
    case "frame":
      return p.manifest?.results ? { ok: true } : fail("app_result_not_allowed", "/source", "results", "this app does not send results");
    default:
      return { ok: true };
  }
}

function formResult(p: Obj, fields: Obj): Verdict {
  const known = new Set((p.fields as Obj[]).map((f) => f.id));
  for (const k of Object.keys(fields).sort()) if (!known.has(k)) return bad(`/value/fields/${k}`, "field", "is not a field of the form");
  for (const f of p.fields as Obj[]) {
    const at = `/value/fields/${f.id}`;
    const val = fields[f.id];
    if (val === undefined || val === null || val === "") {
      if (f.required && f.kind !== "toggle") return bad(at, "required", "is required");
      continue;
    }
    const v = fieldValue(f, val, at);
    if (v) return v;
  }
  return { ok: true };
}

function fieldValue(f: Obj, val: Json, at: string): Verdict | undefined {
  switch (f.kind) {
    case "text":
    case "textarea": {
      const limit = f.maxLength ?? 2000;
      if (typeof val !== "string" || chars(val) > limit) return bad(at, "text", `must be text of at most ${limit} characters`);
      return undefined;
    }
    case "number":
      if (typeof val !== "number" || Number.isNaN(val) || (f.min !== undefined && val < f.min) || (f.max !== undefined && val > f.max)) return bad(at, "number", "must be a number within the limits of the field");
      return undefined;
    case "select":
      if (typeof val !== "string" || !(f.options as Obj[]).some((o) => o.id === val)) return bad(at, "select", "must be one of the options");
      return undefined;
    case "toggle":
      return typeof val === "boolean" ? undefined : bad(at, "toggle", "must be true or false");
    case "date":
      return typeof val === "string" && /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(val) ? undefined : bad(at, "date", "must be a date like 2026-10-17");
    default:
      return undefined;
  }
}

/** Checks one bridge message (schemas/bridge.json): `fromFrame` is what a frame may send, `toFrame` what a host may send. */
export function validateBridge(direction: "fromFrame" | "toFrame", message: unknown): Verdict {
  if (bytes(message) > MAX_BRIDGE) return fail("bridge_invalid", "", "size", `must have at most ${MAX_BRIDGE} bytes`);
  return schemaCheck(`bridge.json#/$defs/${direction}`, message, "bridge_invalid");
}
