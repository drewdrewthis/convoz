// The panel ends a share the moment its tab is no longer the one the owner shared (page-share.feature): stillShared is asked on
// every tab event, so its answer is the whole rule.
import assert from "node:assert/strict";
import { test } from "node:test";
import { stillShared, type SharedTab } from "./share.ts";

const share: SharedTab = { id: "s1", tabId: 7, origin: "https://shop.test" };

/** A Chrome whose tabs.get answers tab 7 with `tab`, or fails as for a closed tab when `tab` is null. */
function withTab(tab: Partial<chrome.tabs.Tab> | null): void {
  (globalThis as unknown as { chrome: unknown }).chrome = {
    tabs: { get: async (id: number) => (id === 7 && tab ? { id, windowId: 1, active: true, ...tab } : Promise.reject(new Error("No tab with id"))) },
  };
}

test("the tab in front of its window on the shared site is still shared, on any page of that site", async () => {
  withTab({ url: "https://shop.test/checkout?token=x#y" });
  assert.equal((await stillShared(share))?.id, 7);
});

test("another tab in front, another site, an address the extension cannot see or a closed tab end the share", async () => {
  const cases: [string, Partial<chrome.tabs.Tab> | null][] = [
    ["another tab in front", { url: "https://shop.test/", active: false }],
    ["another site", { url: "https://other.test/" }],
    ["the same host on http", { url: "http://shop.test/" }],
    ["no address: a site without host access", { url: undefined }],
    ["a browser page", { url: "chrome://extensions/" }],
    ["closed", null],
  ];
  for (const [name, tab] of cases) {
    withTab(tab);
    assert.equal(await stillShared(share), null, name);
  }
});
