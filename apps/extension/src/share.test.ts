// When a share ends and what the panel says (page-share.feature): the share lives while the owner looks at other tabs, and ends only
// on Stop, the tab closing or the tab going to another site. checkShared is asked on every tab event, so its answer is the whole rule.
import assert from "node:assert/strict";
import { test } from "node:test";
import { answer, checkShared, endedText, type SharedTab } from "./share.ts";

const share: SharedTab = { id: "s1", tabId: 7, origin: "https://shop.test" };

/** A Chrome whose tabs.get answers tab 7 with `tab`, or fails as for a closed tab when `tab` is null. */
function withTab(tab: Partial<chrome.tabs.Tab> | null, captured = "data:image/png;base64,UE5H"): void {
  (globalThis as unknown as { chrome: unknown }).chrome = {
    tabs: {
      get: async (id: number) => (id === 7 && tab ? { id, windowId: 1, active: true, ...tab } : Promise.reject(new Error("No tab with id"))),
      captureVisibleTab: async () => captured,
    },
  };
}

test("the tab on the shared site is still shared, on any page of that site, in front or behind another tab", async () => {
  for (const active of [true, false]) {
    withTab({ url: "https://shop.test/checkout?token=x#y", active });
    const got = await checkShared(share);
    assert.ok("tab" in got && got.tab.id === 7, `active ${active}`);
  }
});

test("a closed tab and a tab on another site end the share, each with its own reason", async () => {
  const cases: [string, Partial<chrome.tabs.Tab> | null, string][] = [
    ["closed", null, "tabClosed"],
    ["another site", { url: "https://other.test/" }, "otherSite"],
    ["the same host on http", { url: "http://shop.test/" }, "otherSite"],
    ["no address: a site without host access", { url: undefined }, "otherSite"],
    ["a browser page", { url: "chrome://extensions/" }, "otherSite"],
  ];
  for (const [name, tab, ended] of cases) {
    withTab(tab);
    assert.deepEqual(await checkShared(share), { ended }, name);
  }
});

test("a screenshot of a tab behind another tab says the tab is not in front, and takes no picture", async () => {
  let taken = false;
  withTab({ url: "https://shop.test/", active: false });
  (chrome.tabs as unknown as { captureVisibleTab: () => Promise<string> }).captureVisibleTab = async () => {
    taken = true;
    return "data:image/png;base64,UE5H";
  };
  const tab = await chrome.tabs.get(7);
  assert.deepEqual(await answer(tab, { id: "r1", op: "shot" }), { ok: false, error: "tab not in front" });
  assert.equal(taken, false);
});

test("a screenshot of the tab in front is its PNG", async () => {
  withTab({ url: "https://shop.test/", active: true });
  const tab = await chrome.tabs.get(7);
  assert.deepEqual(await answer(tab, { id: "r1", op: "shot" }), { ok: true, shot: { png_base64: "UE5H" } });
});

test("the panel says exactly why a share ended", () => {
  assert.equal(endedText("stopped", "shop.test"), "Sharing stopped.");
  assert.equal(endedText("tabClosed", "shop.test"), "Sharing ended: the shared tab was closed.");
  assert.equal(endedText("otherSite", "shop.test"), "Sharing ended: the shared tab left shop.test.");
  assert.equal(endedText("gone", "shop.test"), "Sharing ended: Convoz ended it (a newer share, a restart, or no contact for 45 seconds).");
});
