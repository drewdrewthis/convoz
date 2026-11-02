import type { BrowserContext, Page } from "@playwright/test";
import { apiServer, bootstrapOwner } from "../lib/owner.ts";
import { expect, scenario } from "../lib/scenario.ts";
import { browserWorld } from "../lib/wp3.ts";

/*
 * security.feature (contracts), rule "The access log tells one browser tab from many, and names no person". THE PAGE the bindings
 * rely on: every API call the app makes through its client carries X-Convoz-Tab (8 hex, kept in sessionStorage, so one per browser
 * tab) and X-Convoz-Load (8 hex, kept in memory, so one per page load). The owner listener's request line then ends
 * " dev=<device id> tab=<tab> load=<load>"; an id that is not exactly 8 lowercase hex digits is left out.
 * Calls made outside the client (the event stream, the lean shell's head start, error beacons) carry neither: they are not counted.
 */

const ID = /^[0-9a-f]{8}$/;

interface Call {
  path: string;
  tab: string;
  load: string;
}

/** Every API call the page makes that carries either id. */
function watchCalls(page: Page): Call[] {
  const seen: Call[] = [];
  page.on("request", (req) => {
    const url = new URL(req.url());
    const h = req.headers();
    if (!url.pathname.startsWith("/api/") || (h["x-convoz-tab"] === undefined && h["x-convoz-load"] === undefined)) return;
    seen.push({ path: url.pathname, tab: h["x-convoz-tab"] ?? "", load: h["x-convoz-load"] ?? "" });
  });
  return seen;
}

/** Wait until `calls` (those `keep` picks) hold at least two different API paths. */
async function settle(page: Page, calls: Call[], keep: (c: Call) => boolean = () => true): Promise<void> {
  await page.getByRole("heading", { name: "Now", exact: true }).waitFor();
  await expect.poll(() => new Set(calls.filter(keep).map((c) => c.path)).size, { message: "API calls with ids" }).toBeGreaterThanOrEqual(2);
}

/** A new tab of the signed-in browser, on the app's Now page, with its calls watched from its first request. */
async function newTab(context: BrowserContext, origin: string): Promise<{ tab: Page; calls: Call[] }> {
  const tab = await context.newPage();
  const calls = watchCalls(tab);
  await tab.goto(`${origin}/`);
  await settle(tab, calls);
  return { tab, calls };
}

/** The one tab and the one load all of `calls` share; fails if they differ or are not 8 hex digits. */
function oneTabOneLoad(calls: Call[]): { tab: string; load: string } {
  const tabs = [...new Set(calls.map((c) => c.tab))];
  const loads = [...new Set(calls.map((c) => c.load))];
  expect(tabs, `tab ids of ${calls.map((c) => c.path).join(", ")}`).toHaveLength(1);
  expect(loads, `load ids of ${calls.map((c) => c.path).join(", ")}`).toHaveLength(1);
  expect(tabs[0]).toMatch(ID);
  expect(loads[0]).toMatch(ID);
  return { tab: tabs[0]!, load: loads[0]! };
}

scenario("Each tab of the owner's app names its device, tab and load in the access log", { tag: ["@browser"] }, async ({ server, page, context }) => {
  const w = await browserWorld({ server, page, context });
  const device = (await page.evaluate(() => fetch("/api/me").then((r) => r.json()))).device.id as number;

  // When the owner opens the app in two tabs
  const one = await newTab(context, w.srv.origin);
  const two = await newTab(context, w.srv.origin);

  // Then every call of one tab carries one X-Convoz-Tab and one X-Convoz-Load, each 8 hex digits
  const a = oneTabOneLoad(one.calls);
  const b = oneTabOneLoad(two.calls);

  // And the two tabs carry different tab ids and different load ids
  expect(b.tab).not.toBe(a.tab);
  expect(b.load).not.toBe(a.load);

  // And the server log lines of each tab's calls carry dev= with the owner's device id, its tab= and its load=
  for (const ids of [a, b]) {
    const line = new RegExp(`GET /api/\\S+ \\d{3} \\d+ms dev=${device} tab=${ids.tab} load=${ids.load}$`, "m");
    await expect.poll(() => w.srv.log(), { message: `a log line with tab=${ids.tab}` }).toMatch(line);
  }
});

scenario("A reload keeps the tab id and gets a new load id", { tag: ["@browser"] }, async ({ server, page, context }) => {
  const w = await browserWorld({ server, page, context });
  const { tab, calls } = await newTab(context, w.srv.origin);
  const was = oneTabOneLoad(calls);

  // When the owner reloads a tab of the app
  await tab.reload();
  const reloaded = (c: Call) => c.load !== was.load; // a call the page made before it went away still carries the old load
  await settle(tab, calls, reloaded);

  // Then its calls after the reload carry the same X-Convoz-Tab and a new X-Convoz-Load
  const now = oneTabOneLoad(calls.filter(reloaded));
  expect(now.tab).toBe(was.tab);
  expect(now.load).not.toBe(was.load);
});

scenario("A malformed tab or load id and every other header value stay out of the access log", { tag: ["@api"] }, async ({ server }) => {
  const srv = await server(apiServer());
  const owner = await bootstrapOwner(srv);
  const cookie = owner.client.cookieHeader();
  const id = (await owner.client.get("/api/me")).json().device.id as number;

  // When the owner's requests carry malformed X-Convoz-Tab and X-Convoz-Load values and distinctive Cookie, Authorization and X-Foo values
  const bad = ["CAFE0123", "cafe012", "cafe01234", "zzzzzzzz", "cafe-123", "TESTONLYbadid"];
  for (const value of bad) {
    expect((await owner.client.get("/api/me", { headers: { "X-Convoz-Tab": value, "X-Convoz-Load": "0a1b2c3d" } })).status).toBe(200);
    expect((await owner.client.get("/api/me", { headers: { "X-Convoz-Tab": "0a1b2c3d", "X-Convoz-Load": value } })).status).toBe(200);
  }
  const extra = { "X-Foo": "TESTONLYfooval", "X-Convoz-Tab": "1234abcd", "X-Convoz-Load": "5678ef90" };
  expect((await owner.client.get("/api/me", { headers: extra, cookie: `${cookie}; other=TESTONLYcookieval` })).status).toBe(200);
  expect((await owner.client.get("/api/me", { headers: { ...extra, Authorization: "Bearer cvz_s_TESTONLYauthval000000000000" }, cookie: null })).status).toBe(401);

  // Then each malformed id is dropped from its line and never echoed
  await expect.poll(() => srv.log(), { message: "the line with the good ids" }).toMatch(new RegExp(`GET /api/me 200 \\d+ms dev=${id} tab=1234abcd load=5678ef90$`, "m"));
  const log = srv.log();
  expect(log).toMatch(new RegExp(`GET /api/me 200 \\d+ms dev=${id} load=0a1b2c3d$`, "m"));
  expect(log).toMatch(new RegExp(`GET /api/me 200 \\d+ms dev=${id} tab=0a1b2c3d$`, "m"));
  for (const value of bad) expect(log).not.toContain(value);

  // And the server log holds none of the Cookie, Authorization or X-Foo values
  for (const value of [cookie.split("=").slice(1).join("="), "TESTONLYcookieval", "TESTONLYfooval", "TESTONLYauthval", "Bearer", "cvz_"]) expect(log).not.toContain(value);
});
