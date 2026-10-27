import type { Page } from "@playwright/test";
import { agentAsks, askCard, QUESTION } from "../lib/asks.ts";
import { dropStreams, uiWorld } from "../lib/chat-ui.ts";
import { createConversation } from "../lib/chat.ts";
import { useful } from "../lib/perf.ts";
import { expect, scenario } from "../lib/scenario.ts";
import { installed } from "../lib/wp17.ts";

/*
 * THE COLD PAGE (design §12.2, AC-10): a first screen loaded with an empty cache (Now at /, the conversation list at /chats) comes in one
 * response: its code, its stylesheet and its first reads (a JSON data block) inline, each inline block allowed by its hash in the CSP.
 * Read with specs/contracts/poor-network.feature. The budget itself is measured in poor-network.perf.spec.ts.
 */

const TITLE = "Ship search filters";
const SCREENS = [
  { name: "Now", path: "/", data: "/api/now", shows: (page: Page) => askCard(page, QUESTION) },
  { name: "the conversation list", path: "/chats", data: "/api/conversations", shows: (page: Page) => page.getByRole("link", { name: new RegExp(TITLE) }).first() },
];

/** Keep every Content-Security-Policy violation the page reports in window.__csp. */
async function recordViolations(page: Page): Promise<void> {
  await page.addInitScript(() => {
    (window as unknown as { __csp: string[] }).__csp = [];
    document.addEventListener("securitypolicyviolation", (e) => (window as unknown as { __csp: string[] }).__csp.push(`${e.violatedDirective} ${e.blockedURI} ${e.sample}`));
  });
}

scenario("A cold first screen comes in one response", { tag: ["@browser"] }, async ({ server, page, context, browser }, info) => {
  info.setTimeout(90_000);
  const u = await uiWorld({ server, page, context }, { agents: ["devtool"] });
  const conv = await createConversation(u.w.owner, { participants: ["devtool"], title: TITLE });
  await agentAsks(u.w.srv, u.sessions.devtool!.lease, conv);
  for (const screen of SCREENS) {
    // When the owner opens Now and the conversation list with an empty cache
    // (each in a browser of its own: no service worker, no HTTP cache, no IndexedDB copy, so the browser itself asks for the page)
    const cold = await browser.newContext({ storageState: await context.storageState(), serviceWorkers: "block", viewport: info.project.use.viewport, isMobile: info.project.use.isMobile, hasTouch: info.project.use.hasTouch });
    try {
      const tab = await cold.newPage();
      await recordViolations(tab);
      const requested: string[] = [];
      tab.on("request", (r) => requested.push(new URL(r.url()).pathname));
      const answer = await tab.goto(`${u.w.srv.origin}${screen.path}`);
      const load = await useful(tab, 30_000);
      await expect(screen.shows(tab)).toBeVisible({ timeout: 30_000 });

      // Then each document carries the screen's code, its stylesheet and its first reads, and the screen draws from them
      const html = (await answer!.text()) ?? "";
      expect(/<script type="module">([\s\S]*?)<\/script>/.exec(html)?.[1]?.length ?? 0, `${screen.name}: the main bundle inline`).toBeGreaterThan(10_000);
      expect(/<style>([\s\S]*?)<\/style>/.exec(html)?.[1]?.length ?? 0, `${screen.name}: the stylesheet inline`).toBeGreaterThan(1_000);
      expect(requested.filter((p) => /^\/assets\/main-.*\.(js|css)$/.test(p)), `${screen.name}: the main bundle or stylesheet asked for by URL`).toEqual([]);
      // (the page removes its data block once it has read it, so the block is read from the response)
      const block = JSON.parse(/<script type="application\/json" id="cz-data">([\s\S]*?)<\/script>/.exec(html)?.[1] ?? "null") as { generated_at: number; reads: Record<string, unknown> } | null;
      expect(Object.keys(block?.reads ?? {}), `${screen.name}: the reads in the data block`).toContain(screen.data);
      expect(load.inline[screen.data], `${screen.name}: ${screen.data} taken from the document before the mark at ${load.tfus}`).toBeLessThanOrEqual(load.tfus);
      await expect(tab.locator("#cz-data"), `${screen.name}: the data block removed once read`).toHaveCount(0);
      expect(answer!.headers()["cache-control"], `${screen.name}: Cache-Control`).toBe("no-store");
      expect(answer!.headers()["content-security-policy"], `${screen.name}: the CSP`).not.toContain("unsafe-inline");

      // And the browser reports no Content-Security-Policy violation
      expect(await tab.evaluate(() => (window as unknown as { __csp: string[] }).__csp), `${screen.name}: CSP violations`).toEqual([]);
    } finally {
      await cold.close();
    }
  }
});

scenario("The service worker never caches a page with user data", { tag: ["@browser", "@I-39"] }, async ({ server, page, context }, info) => {
  info.setTimeout(90_000);
  const u = await uiWorld({ server, page, context }, { agents: ["devtool"] });
  const conv = await createConversation(u.w.owner, { participants: ["devtool"], title: TITLE });
  await agentAsks(u.w.srv, u.sessions.devtool!.lease, conv);
  // Given the owner opened Now and the conversation list, and the service worker controls the app
  for (const screen of SCREENS) {
    await page.goto(`${u.w.srv.origin}${screen.path}`);
    await expect(screen.shows(page)).toBeVisible({ timeout: 30_000 });
  }
  await installed(page);

  // When both pages open again through the service worker
  for (const screen of SCREENS) {
    // The same URL asked for by the browser itself is a cold page with the owner's data in it...
    expect(await (await context.request.get(`${u.w.srv.origin}${screen.path}`)).text(), `${screen.name}: the browser's own load`).toContain('id="cz-data"');
    await page.goto(`${u.w.srv.origin}${screen.path}`);
    await expect(screen.shows(page)).toBeVisible({ timeout: 30_000 });
    expect(await page.evaluate(() => Boolean(navigator.serviceWorker.controller)), `${screen.name}: through the worker`).toBe(true);
    // ...and the worker asks for the lean shell: the page it hands over holds no data block.
    expect(await page.evaluate(() => Boolean(document.getElementById("cz-data"))), `${screen.name}: a data block in the page the worker gave`).toBe(false);
  }

  // Then Cache Storage holds no page with a data block
  const held = await page.evaluate(async () => {
    const out: { url: string; data: boolean; html: boolean }[] = [];
    for (const name of await caches.keys()) {
      const cache = await caches.open(name);
      for (const request of await cache.keys()) {
        const text = await (await cache.match(request))!.text();
        out.push({ url: new URL(request.url).pathname + new URL(request.url).search, data: text.includes('id="cz-data"'), html: text.includes("<!doctype html>") });
      }
    }
    return out;
  });
  // The probe reads page bodies: the shell the worker keeps is one, so a page with data would be seen.
  expect(held.filter((e) => e.html).map((e) => e.url.replace(/&__WB_REVISION__=.*$/, "")), "the pages Cache Storage holds").toContain("/signin?shell=1");
  expect(held.filter((e) => e.data).map((e) => e.url), "pages in Cache Storage with a data block").toEqual([]);
});

scenario("A page back from the back-forward cache checks the session again", { tag: ["@browser"] }, async ({ server, page, context }) => {
  const u = await uiWorld({ server, page, context }, { agents: ["devtool"] });
  const conv = await createConversation(u.w.owner, { participants: ["devtool"], title: TITLE });
  await agentAsks(u.w.srv, u.sessions.devtool!.lease, conv);
  // Given the owner has Now open
  await page.goto(`${u.w.srv.origin}/`);
  await expect(askCard(page, QUESTION)).toBeVisible({ timeout: 30_000 });
  // A page in the back-forward cache runs nothing: its live stream is gone (closed without the page knowing, as a frozen page's is),
  // and nothing else of it reaches the server, so only the page coming back can find out that the session ended.
  await dropStreams(page);
  await page.route((url) => url.pathname.startsWith("/api/") && url.pathname !== "/api/me", (route) => route.abort());

  // When the session ends and the page comes back from the back-forward cache
  const out = await context.request.post(`${u.w.srv.origin}/api/auth/logout`, { headers: { Origin: u.w.srv.origin, "X-Convoz": "1", "Content-Type": "application/json" }, data: "{}" });
  expect(out.status(), "logout").toBe(204);
  const asked = page.waitForRequest((r) => new URL(r.url()).pathname === "/api/me", { timeout: 2_000 });
  // From a timer, so the evaluate returns before the 401 it causes moves the page to sign in (that would destroy its context).
  await page.evaluate(() => void setTimeout(() => dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }))));

  // Then the browser opens sign in
  await asked; // the page asked who is signed in at once, before its next poll could notice
  await expect(page).toHaveURL(/\/signin/, { timeout: 5_000 });
});
