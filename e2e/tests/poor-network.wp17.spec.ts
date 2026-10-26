import { brotliCompressSync, constants } from "node:zlib";
import type { Route } from "@playwright/test";
import { chatsHeading, composer, message, messageLog, sendButton } from "../lib/chat-ui.ts";
import { createConversation, messagesOf, ownerSays } from "../lib/chat.ts";
import { seedMessages } from "../lib/event.ts";
import { expect, scenario } from "../lib/scenario.ts";
import { cachedMessages, installed, pageLink, stored, world } from "../lib/wp17.ts";

/*
 * PWA AND POOR NETWORK (WP17), poor connections. Read with specs/features/poor-network.feature and specs/contracts/poor-network.feature.
 * "Offline" is the browser's own emulation: a page's link by CDP (the other page of the context stays online), or the whole context
 * for the scenarios that open the app from the service worker. The lossy profile is 400 ms, 400 kbps (lib/wp17.ts).
 * Left unbound here: "A voice note upload cut halfway resumes" (it needs WP10's upload code) and "With Save-Data on, no media loads
 * until tapped" (the base has no image, unfurl or app-preview rendering to hold back). "The first useful screen appears in budget"
 * is bound in poor-network.perf.spec.ts.
 */

const SHIP = "Ship search filters";
const bannerOf = (page: import("@playwright/test").Page) => page.getByRole("status").filter({ hasText: /Offline · last synced/ });

scenario("Twenty messages sent across three outages arrive once and in order", { tag: ["@browser", "@lossy"] }, async ({ server, page, context }, info) => {
  info.setTimeout(240_000);
  // Given the owner's browser is on the lossy profile
  const u = await world({ server, page, context });
  const conv = await createConversation(u.w.owner, { participants: ["devtool"], title: SHIP });
  const second = await context.newPage();
  await second.goto(`${u.w.srv.origin}/chats/${conv}`);
  await expect(composer(second)).toBeVisible({ timeout: 30_000 });
  await page.goto(`${u.w.srv.origin}/chats/${conv}`);
  await expect(composer(page)).toBeVisible({ timeout: 30_000 });
  const link = await pageLink(context, page, { lossy: true });
  await link(false);

  // When the owner sends 20 numbered messages and the browser goes offline 3 times while sending
  for (let n = 1; n <= 20; n++) {
    if ([4, 9, 14].includes(n)) await link(true);
    await composer(page).fill(`numbered ${n}`);
    await sendButton(page).click();
    if ([6, 11, 16].includes(n)) await link(false);
  }
  await link(false);

  // Then a second browser shows messages 1 to 20 exactly once and in order
  await expect(messageLog(second).getByRole("article")).toHaveText(
    Array.from({ length: 20 }, (_, i) => new RegExp(`numbered ${i + 1}$`)),
    { timeout: 120_000 },
  );
  expect((await messagesOf(u.w.owner, conv)).map((m) => m.body)).toEqual(Array.from({ length: 20 }, (_, i) => `numbered ${i + 1}`));

  // And the first browser shows no message as "failed · retry"
  await expect(messageLog(page).getByText("sending", { exact: true })).toHaveCount(0, { timeout: 60_000 });
  await expect(messageLog(page).getByText("failed", { exact: false })).toHaveCount(0);
  await expect(messageLog(page).getByRole("button", { name: "Retry" })).toHaveCount(0);
});

scenario("A message sent offline waits in the outbox", { tag: ["@browser", "@lossy"] }, async ({ server, page, context }, info) => {
  info.setTimeout(120_000);
  // Given the owner's browser is offline
  const u = await world({ server, page, context });
  const conv = await createConversation(u.w.owner, { participants: ["devtool"], title: SHIP });
  await page.goto(`${u.w.srv.origin}/chats/${conv}`);
  await expect(composer(page)).toBeVisible({ timeout: 30_000 });
  const link = await pageLink(context, page, { lossy: true });
  await link(true);

  // When the owner sends "be back soon"
  await composer(page).fill("be back soon");
  await sendButton(page).click();

  // Then the bubble shows "sending"
  const bubble = message(page, "be back soon");
  await expect(bubble).toContainText("sending");
  await page.waitForTimeout(2_000);
  await expect(bubble).toContainText("sending");
  expect((await stored(page))?.outbox).toBe(1);
  expect(await messagesOf(u.w.owner, conv)).toEqual([]);

  // And it is delivered once when the browser is back online
  await link(false);
  await expect(bubble).not.toContainText("sending", { timeout: 60_000 });
  expect((await messagesOf(u.w.owner, conv)).map((m) => m.body)).toEqual(["be back soon"]);
  await expect(message(page, "be back soon")).toHaveCount(1);
  await expect.poll(async () => (await stored(page))?.outbox).toBe(0);
});

scenario("Settings shows the connection quality", { tag: ["@browser"] }, async ({ server, page, context }) => {
  const u = await world({ server, page, context });

  // When the owner opens Settings → Advanced → Connection
  await page.goto(`${u.w.srv.origin}/settings`);
  await page.getByRole("button", { name: "Advanced" }).click();
  await page.getByRole("button", { name: "Connection" }).click();

  // Then it shows the median RTT, the last 20 samples and the effective connection type
  const summary = page.getByRole("list", { name: "Connection" });
  await expect(summary.getByRole("listitem").filter({ hasText: "Median round trip" })).toContainText(/\d+ ms/);
  await expect(summary.getByRole("listitem").filter({ hasText: "Connection type" })).toContainText(/(slow-2g|2g|3g|4g|unknown)$/);
  const samples = page.getByRole("list", { name: "Samples" }).getByRole("listitem");
  await expect(samples).toHaveCount(3, { timeout: 15_000 });
  await expect(samples.first()).toContainText(/^\d+ ms$/);
  expect(await samples.count()).toBeLessThanOrEqual(20);
});

scenario("A network error never wipes the offline cache", { tag: ["@browser"] }, async ({ server, page, context }, info) => {
  info.setTimeout(120_000);
  // Given the installed app has cached conversation 41
  const u = await world({ server, page, context });
  const conv = await createConversation(u.w.owner, { participants: ["devtool"], title: SHIP });
  await ownerSays(u.w.owner, conv, "cached before the outage");
  await page.goto(`${u.w.srv.origin}/chats/${conv}`);
  await expect(message(page, "cached before the outage")).toBeVisible();
  await installed(page);
  await cachedMessages(page, conv, 1);
  await expect.poll(async () => (await stored(page))?.meta).toContain("syncedAt");
  let mode: "down" | "refuse" = "down";
  await page.route("**/api/**", (route) =>
    mode === "down" ? route.abort("connectionrefused") : route.fulfill({ status: 502, contentType: "application/json", body: JSON.stringify({ error: { code: "bad_gateway", message: "upstream" } }) }),
  );

  // When the server cannot be reached and then refuses one request for a reason other than a revoked device
  await page.reload();
  await expect(message(page, "cached before the outage")).toBeVisible({ timeout: 20_000 });
  mode = "refuse";
  await page.reload();

  // Then conversation 41 still opens from the cache with the last sync time shown
  await expect(message(page, "cached before the outage")).toBeVisible({ timeout: 20_000 });
  await expect(bannerOf(page)).toBeVisible();
  expect((await stored(page))?.messages[conv]).toBe(1);
  expect((await stored(page))?.me).toBe(1);
});

scenario("A revoked device clears the offline cache", { tag: ["@browser"] }, async ({ server, page, context }, info) => {
  info.setTimeout(120_000);
  // Given the installed app has cached conversation 41
  const u = await world({ server, page, context });
  const conv = await createConversation(u.w.owner, { participants: ["devtool"], title: SHIP });
  await ownerSays(u.w.owner, conv, "cached before the revoke");
  await page.goto(`${u.w.srv.origin}/chats/${conv}`);
  await expect(message(page, "cached before the revoke")).toBeVisible();
  await installed(page);
  await cachedMessages(page, conv, 1);

  // When the owner revokes this device from another device
  const devices = (await u.w.owner.client.get("/api/me/devices")).json().devices as { id: number; current: boolean }[];
  const mine = devices.filter((d) => !d.current);
  expect(mine).toHaveLength(1);
  expect((await u.w.owner.client.del(`/api/me/devices/${mine[0]!.id}`)).status).toBe(204);

  // Then on its next request the app clears its stored data and shows sign in
  await composer(page).fill("after the revoke");
  await sendButton(page).click();
  await expect(page).toHaveURL(/\/signin/, { timeout: 20_000 });
  await expect(page.getByRole("button", { name: "Sign in with a passkey" })).toBeVisible();
  await expect.poll(async () => await stored(page)).toEqual({ messages: {}, conversations: 0, me: 0, outbox: 0, meta: [] });
});

scenario("Only a revoking 401 clears the offline cache", { tag: ["@browser"] }, async ({ server, page, context }, info) => {
  info.setTimeout(240_000);
  const u = await world({ server, page, context });
  const conv = await createConversation(u.w.owner, { participants: ["devtool"], title: SHIP });
  await ownerSays(u.w.owner, conv, "kept unless revoked");
  const rows = [
    { response: "a 502", status: 502, code: "bad_gateway", cleared: false },
    { response: 'a 401 with "token_invalid"', status: 401, code: "token_invalid", cleared: false },
    { response: 'a 401 with "device_revoked"', status: 401, code: "device_revoked", cleared: true },
    { response: 'a 401 with "session_expired"', status: 401, code: "session_expired", cleared: true },
  ];
  for (const row of rows) {
    // Given the installed app has cached conversation 41
    await page.goto(`${u.w.srv.origin}/chats/${conv}`);
    await expect(message(page, "kept unless revoked"), row.response).toBeVisible();
    await installed(page);
    await cachedMessages(page, conv, 1);

    // When the next request gets <response>
    await page.route("**/api/**", (route) => route.fulfill({ status: row.status, contentType: "application/json", body: JSON.stringify({ error: { code: row.code, message: "refused" } }) }));
    await page.reload();

    // Then the cache is <outcome>
    if (row.cleared) {
      await expect(page, row.response).toHaveURL(/\/signin/, { timeout: 20_000 });
      await expect.poll(async () => (await stored(page))?.messages[conv] ?? 0, { message: row.response }).toBe(0);
    } else {
      await expect(message(page, "kept unless revoked"), row.response).toBeVisible({ timeout: 20_000 });
      expect((await stored(page))?.messages[conv], row.response).toBe(1);
    }
    await page.unroute("**/api/**");
  }
});

scenario("A conversation opens from the offline copy before the server answers", { tag: ["@browser"] }, async ({ server, page, context }, info) => {
  info.setTimeout(120_000);
  // Given the installed app has cached conversation 41 with 5 messages
  const u = await world({ server, page, context });
  const conv = await createConversation(u.w.owner, { participants: ["devtool"], title: SHIP });
  await seedMessages(u.w.srv, conv, 4);
  await ownerSays(u.w.owner, conv, "the newest before the hold");
  await page.goto(`${u.w.srv.origin}/chats/${conv}`);
  await expect(message(page, "the newest before the hold")).toBeVisible();
  await installed(page);
  await cachedMessages(page, conv, 5);
  await expect.poll(async () => (await stored(page))?.conversations ?? 0).toBeGreaterThanOrEqual(1);
  // a fresh page: what it holds of the conversation's messages can only come from IndexedDB
  await page.goto(`${u.w.srv.origin}/chats`);
  await expect(chatsHeading(page)).toBeVisible();

  // When the server holds its answers to /api/me, /api/identities and conversation 41 and the owner opens conversation 41
  const held: Route[] = [];
  const holds = (url: URL) =>
    ["/api/me", "/api/identities", `/api/conversations/${conv}`].includes(url.pathname) || url.pathname.startsWith(`/api/conversations/${conv}/messages`);
  await page.route(holds, (route) => void held.push(route));
  await page.getByRole("heading", { name: SHIP }).click();

  // Then the last message shows within 3 seconds
  await expect(message(page, "the newest before the hold")).toBeVisible({ timeout: 3_000 });
  expect(held.map((r) => new URL(r.request().url()).pathname)).toContain(`/api/conversations/${conv}`);

  // And the page stays the same once the server answers
  const answered = page.waitForResponse((r) => new URL(r.url()).pathname.startsWith(`/api/conversations/${conv}/messages`));
  for (const route of held) await route.continue();
  await page.unroute(holds);
  await answered;
  await expect(message(page, "the newest before the hold")).toBeVisible();
  await expect(composer(page)).toBeVisible();
  await expect(page.getByText("This conversation does not exist")).toHaveCount(0);
});

scenario("The conversation list is read from the network once per page load", { tag: ["@browser"] }, async ({ server, page, context }, info) => {
  info.setTimeout(120_000);
  // Given the installed app has cached conversation 41
  const u = await world({ server, page, context });
  await createConversation(u.w.owner, { participants: ["devtool"], title: SHIP });
  await page.goto(`${u.w.srv.origin}/chats`);
  await expect(chatsHeading(page)).toBeVisible();
  await installed(page);
  await page.waitForFunction(() => performance.getEntriesByName("kept-offline").length > 0, undefined, { timeout: 30_000 });
  await expect.poll(async () => (await stored(page))?.conversations ?? 0).toBeGreaterThanOrEqual(1);

  const conv = Number(new URL(await page.getByRole("link", { name: new RegExp(SHIP) }).first().getAttribute("href") ?? "", u.w.srv.origin).pathname.split("/").pop());
  // load: a page load of /chats; back: from a conversation back to the list in the same page; restore / show: a pageshow that is a
  // bfcache return (persisted) or not
  const rows = [
    { start: "normally", how: "load", failFirst: false, asked: 1, answered: 1, atLeast: false },
    { start: "and its first list read fails (disk copy only)", how: "load", failFirst: true, asked: 2, answered: 1 },
    { start: "again after opening a conversation", how: "back", failFirst: false, asked: 1, answered: 1 },
    // a return wakes the rail and the list (each resumes on its own), so it can take one queued read more: it must read, at least once
    { start: "again from the back-forward cache", how: "restore", failFirst: false, asked: 1, answered: 1, atLeast: true },
    { start: "with a page show that is not a return", how: "show", failFirst: false, asked: 0, answered: 0 },
  ];
  const isList = (url: URL) => url.pathname === "/api/conversations";
  for (const row of rows) {
    // When the owner opens the conversation list <start>
    if (row.how === "back") {
      await page.getByRole("link", { name: new RegExp(SHIP) }).first().click();
      await expect(page).toHaveURL(new RegExp(`/chats/${conv}$`));
      await expect(composer(page)).toBeVisible();
      await page.waitForTimeout(2_500); // past the 2 s a screen that mounts may reuse the list for: going back must read again
    }
    const asked: string[] = [];
    const answered: string[] = [];
    const onRequest = (r: import("@playwright/test").Request) => void (isList(new URL(r.url())) && r.method() === "GET" && asked.push(r.url()));
    const onResponse = (r: import("@playwright/test").Response) => void (isList(new URL(r.url())) && r.request().method() === "GET" && answered.push(r.url()));
    page.on("request", onRequest);
    page.on("response", onResponse);
    let failed = !row.failFirst;
    await page.route(isList, (route) => {
      if (failed) return route.continue();
      failed = true;
      return route.abort("internetdisconnected");
    });
    if (row.how === "load") {
      await page.goto(`${u.w.srv.origin}/chats`);
    } else if (row.how === "back") {
      await page.goBack();
      await expect(page).toHaveURL(/\/chats$/);
    } else {
      await page.evaluate((persisted) => dispatchEvent(new PageTransitionEvent("pageshow", { persisted })), row.how === "restore");
    }
    await expect(page.getByRole("heading", { name: SHIP }), row.start).toBeVisible({ timeout: 20_000 });

    // And the app has saved its offline copy
    await page.waitForFunction(() => performance.getEntriesByName("kept-offline").length > 0, undefined, { timeout: 30_000 });
    await page.waitForTimeout(row.how === "load" ? 500 : 1_500); // a read the page starts late would be a second one: let it show

    // Then the app asked the server for the conversation list <asked> times and got <answered> answers (1+ is at least once)
    if (row.atLeast) {
      expect(asked.length, `${row.start}: list requests`).toBeGreaterThanOrEqual(row.asked);
      expect(answered.length, `${row.start}: list answers`).toBeGreaterThanOrEqual(row.answered);
    } else {
      expect(asked.length, `${row.start}: list requests`).toBe(row.asked);
      expect(answered.length, `${row.start}: list answers`).toBe(row.answered);
    }
    page.off("request", onRequest);
    page.off("response", onResponse);
    await page.unroute(isList);
  }
});

scenario("The offline copy reads a few conversations at once", { tag: ["@browser"] }, async ({ server, page, context }, info) => {
  info.setTimeout(120_000);
  // Given the owner has 8 conversations
  const u = await world({ server, page, context });
  for (let n = 1; n <= 8; n++) await createConversation(u.w.owner, { participants: ["devtool"], title: `Thread ${n}` });
  await page.goto(`${u.w.srv.origin}/chats`);
  await expect(chatsHeading(page)).toBeVisible();
  await installed(page);
  await page.waitForFunction(() => performance.getEntriesByName("kept-offline").length > 0, undefined, { timeout: 30_000 });

  // When the owner opens the conversation list and the server takes 300 ms to answer each message read
  let inFlight = 0;
  let peak = 0;
  let total = 0;
  const isMessages = (url: URL) => /^\/api\/conversations\/\d+\/messages$/.test(url.pathname);
  await page.route(isMessages, async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    inFlight++;
    peak = Math.max(peak, inFlight);
    total++;
    try {
      await new Promise((r) => setTimeout(r, 300));
      const res = await route.fetch();
      await route.fulfill({ response: res });
    } finally {
      inFlight--;
    }
  });
  await page.goto(`${u.w.srv.origin}/chats`);
  await expect(chatsHeading(page)).toBeVisible();

  // And the app has saved its offline copy
  await page.waitForFunction(() => performance.getEntriesByName("kept-offline").length > 0, undefined, { timeout: 30_000 });

  // Then the app had at most 4 message reads in flight at once, and more than 1
  expect(total, "message reads").toBeGreaterThanOrEqual(8);
  expect(peak, "most reads in flight at once").toBeLessThanOrEqual(4);
  expect(peak).toBeGreaterThan(1);

  // And the offline copy holds every conversation
  await expect.poll(async () => (await stored(page))?.conversations ?? 0).toBeGreaterThanOrEqual(8);
  await page.unroute(isMessages);

  // When the owner opens the conversation list again and the server refuses the first message read with a 404
  let n = 0;
  const ended: number[] = [];
  await page.route(isMessages, async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    if (n++ === 0) {
      // A 404 is a refusal the offline cache does not cover, so the read throws.
      return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: { code: "not_found", message: "gone" } }) });
    }
    await new Promise((r) => setTimeout(r, 300));
    const res = await route.fetch();
    await route.fulfill({ response: res });
    ended.push(Date.now());
  });
  await page.goto(`${u.w.srv.origin}/chats`);
  await expect(chatsHeading(page)).toBeVisible();
  await page.waitForFunction(() => performance.getEntriesByName("kept-offline").length > 0, undefined, { timeout: 30_000 });
  const markAt = await page.evaluate(() => performance.timeOrigin + performance.getEntriesByName("kept-offline")[0]!.startTime);

  // Then the app saves its offline copy only after the other message reads in flight have ended
  expect(ended.length, "other reads that ended").toBeGreaterThan(0);
  // Node and the page share the machine clock; 50 ms covers the gap between the route's fulfill and the page's receipt.
  expect(Math.max(...ended), "the last other read ended before the mark").toBeLessThanOrEqual(markAt + 50);
  await page.unroute(isMessages);
});

scenario("The offline shell opens with the cached rail and Now", { tag: ["@browser"] }, async ({ server, page, context }, info) => {
  info.setTimeout(240_000);
  // Given the installed app synced the 20 most recent conversations
  const u = await world({ server, page, context });
  const big = await createConversation(u.w.owner, { participants: ["devtool"], title: "Busy thread" });
  await seedMessages(u.w.srv, big, 230);
  for (let n = 1; n <= 21; n++) await createConversation(u.w.owner, { participants: ["devtool"], title: `Thread ${n}` });
  await ownerSays(u.w.owner, big, "the newest of the busy thread");
  await page.goto(`${u.w.srv.origin}/chats`);
  await expect(chatsHeading(page)).toBeVisible();
  await installed(page);
  // The page signed in on (Now) synced while the conversations were being made, and its copy can already hold 200 messages of the
  // busy thread: only this page's `kept-offline` mark (set once its sync is on disk) says the copy holds all 21 threads and the newest.
  await page.waitForFunction(() => performance.getEntriesByName("kept-offline").length > 0, undefined, { timeout: 30_000 });
  await cachedMessages(page, big, 200);
  await expect.poll(async () => (await stored(page))?.meta).toContain("now");

  // When the device is offline and the app opens
  await context.setOffline(true);
  await page.goto(`${u.w.srv.origin}/`);

  // Then the rail, Now and the last 200 messages of each cached conversation show
  await expect(page.getByRole("heading", { name: "Now", exact: true })).toBeVisible({ timeout: 20_000 });
  await page.getByRole("link", { name: "Conversations", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Thread 21" })).toBeVisible({ timeout: 20_000 });
  await page.getByRole("heading", { name: "Busy thread" }).click();
  await expect(message(page, "the newest of the busy thread")).toBeVisible({ timeout: 20_000 });
  expect((await stored(page))?.messages[big]).toBe(200);
  await messageLog(page).evaluate((log) => (log.scrollTop = 0));
  await expect(message(page, "Seeded message 32 about")).toBeVisible();
  await expect(message(page, "Seeded message 31 about")).toHaveCount(0);

  // And a banner shows the last sync time
  await expect(bannerOf(page)).toBeVisible();
});

scenario("The initial download stays small", { tag: ["@browser"] }, async ({ server, page, context, browser }) => {
  // The owner signs in first; the measured load is then a cold load of Now in a new browser: no HTTP cache, no worker. A cold load
  // carries the first screen's script and stylesheet inside the document (design §12.2), so those inline blocks count too, at the
  // size brotli gives them; the data block is data, not code.
  const u = await world({ server, page, context });
  const cold = await browser.newContext({ storageState: await context.storageState(), serviceWorkers: "block" });
  const fresh = await cold.newPage();
  const cdp = await cold.newCDPSession(fresh);
  await cdp.send("Network.enable");
  await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
  const files = new Map<string, { type: string; encoding: string; bytes: number }>();
  let documentId = "";
  cdp.on("Network.responseReceived", (e) => {
    const encoding = String(Object.entries(e.response.headers).find(([name]) => name.toLowerCase() === "content-encoding")?.[1] ?? "");
    if (e.type === "Document") documentId = e.requestId;
    if (e.type === "Script" || e.type === "Stylesheet" || e.type === "Document") files.set(e.requestId, { type: e.type, encoding, bytes: 0 });
  });
  cdp.on("Network.loadingFinished", (e) => {
    const file = files.get(e.requestId);
    if (file) file.bytes = e.encodedDataLength;
  });

  // When the production build is measured
  await fresh.goto(`${u.w.srv.origin}/`);
  await expect(fresh.getByRole("heading", { name: "Now", exact: true })).toBeVisible();

  // Then the initial JavaScript is at most 150 KB and the CSS at most 20 KB with brotli
  const { body } = await cdp.send("Network.getResponseBody", { requestId: documentId });
  const inline = (tag: string) =>
    [...body.matchAll(new RegExp(`<${tag}(\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "g"))].filter((m) => !/\ssrc=|application\/json/.test(m[1] ?? "")).map((m) => m[2]!).join("");
  const brotli = (text: string) => (text ? brotliCompressSync(Buffer.from(text), { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }).length : 0);
  const sum = (type: string) => [...files.values()].filter((f) => f.type === type).reduce((n, f) => n + f.bytes, 0);
  const js = sum("Script") + brotli(inline("script"));
  const css = sum("Stylesheet") + brotli(inline("style"));
  expect([...files.values()].filter((f) => f.encoding !== "br" && f.bytes > 1024)).toEqual([]);
  expect(js).toBeGreaterThan(10_000);
  expect(js).toBeLessThanOrEqual(150 * 1024);
  expect(css).toBeGreaterThan(1_000);
  expect(css).toBeLessThanOrEqual(20 * 1024);
  await cold.close();
});
