// AC 1 of issue 44: the manifest asks for the least access, and the check fails on anything more.
import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { leastAccessProblems } from "./least-access.ts";

const manifest = JSON.parse(fs.readFileSync(new URL("../manifest.json", import.meta.url), "utf8")) as Record<string, unknown>;

test("the manifest asks for exactly sidePanel, activeTab, scripting and storage, and host access only at run time", () => {
  assert.deepEqual(leastAccessProblems(manifest), []);
});

test("any other permission fails the check", () => {
  for (const extra of ["tabs", "cookies", "history", "<all_urls>"]) {
    const more = { ...manifest, permissions: [...(manifest.permissions as string[]), extra] };
    assert.notDeepEqual(leastAccessProblems(more), [], extra);
  }
  assert.notDeepEqual(leastAccessProblems({ ...manifest, permissions: ["activeTab", "storage"] }), []);
});

test("host_permissions, content scripts, optional permissions and a wider optional host fail the check", () => {
  const bad: Record<string, unknown>[] = [
    { host_permissions: ["https://convoz.example.ts.net/*"] },
    { content_scripts: [{ matches: ["https://*/*"], js: ["x.js"] }] },
    { optional_permissions: ["tabs"] },
    { optional_host_permissions: ["https://*/*", "http://*/*"] },
    { optional_host_permissions: ["<all_urls>"] },
    { optional_host_permissions: ["*"] },
    { optional_host_permissions: ["*://*/*"] },
    { host_permissions: ["*"] },
    { host_permissions: ["*://*/*"] },
  ];
  for (const change of bad) assert.notDeepEqual(leastAccessProblems({ ...manifest, ...change }), [], JSON.stringify(change));
});

test("the manifest pins the extension ID with a key", () => {
  assert.equal(typeof manifest.key, "string");
});
