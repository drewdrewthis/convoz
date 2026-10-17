import type { Page } from "@playwright/test";
import { agentAsks, askCard, QUESTION } from "../lib/asks.ts";
import { uiWorld } from "../lib/chat-ui.ts";
import { createConversation } from "../lib/chat.ts";
import { seedMessages } from "../lib/event.ts";
import { emptyCache, phoneProfile, useful, type Network, type Useful } from "../lib/perf.ts";
import { expect, scenario } from "../lib/scenario.ts";
import { installed, stored } from "../lib/wp17.ts";

/*
 * CLIENT BUDGET (design §12.2, AC-10): the binding of "The first useful screen appears in budget" in specs/contracts/poor-network.feature.
 * The phone is the "mobile" project's 390 px touch window in a context of its own that holds only the owner's cookie, so no test
 * script runs in its pages; its CPU is slowed 4 times and its link (the page's and its service worker's) is Fast-3G or lossy (lib/perf.ts).
 * A phone has two first screens, and both are measured: Now at /, and the rail, which on a phone is the conversation list at /chats
 * (prototype v41; "On a phone the rail matches the prototype"). The time is the app's `tfus` mark, set when the screen holds its data.
 * The box runs many browsers, so each screen loads several times after a warm-up and the fastest load counts (as in "My own message
 * shows at once"); the budget is the feature's.
 * The device holds a full offline copy: 20 conversations with their last 200 messages (design §9), and an ask waits on Now.
 */

const ROWS: { network: Network; start: "warm from IndexedDB" | "cold with an empty cache"; budget: number }[] = [
  { network: "Fast-3G", start: "warm from IndexedDB", budget: 300 },
  { network: "lossy", start: "warm from IndexedDB", budget: 300 },
  { network: "Fast-3G", start: "cold with an empty cache", budget: 1500 },
  { network: "lossy", start: "cold with an empty cache", budget: 4000 },
];

const TITLE = "Ship search filters";
const SCREENS = [
  { name: "Now", path: "/", data: "/api/now", shows: (page: Page) => askCard(page, QUESTION) },
  { name: "the rail", path: "/chats", data: "/api/conversations", shows: (page: Page) => page.getByRole("link", { name: new RegExp(TITLE) }) },
];
const KEPT_CONVERSATIONS = 20;
const KEPT_MESSAGES = 200;
/** Loads per screen: a warm load is short and noisy, a cold one is long and bound by the link. */
const TRIALS = { "warm from IndexedDB": 12, "cold with an empty cache": 3 };

scenario("The first useful screen appears in budget", { tag: ["@browser", "@phone", "@lossy"] }, async ({ server, page, context, browser }, info) => {
  info.setTimeout(420_000);
  // Background: owner "drew" signed in, machine "box-2" with allow-list "devtool", and conversation 41 "Ship search filters"
  const u = await uiWorld({ server, page, context }, { agents: ["devtool"] });
  const origin = u.w.srv.origin;
  const conv = await createConversation(u.w.owner, { participants: ["devtool"], title: TITLE });
  await seedMessages(u.w.srv, conv, KEPT_MESSAGES);
  for (let n = 2; n <= KEPT_CONVERSATIONS; n++) await seedMessages(u.w.srv, await createConversation(u.w.owner, { participants: ["devtool"], title: `Older work ${n}` }), KEPT_MESSAGES);
  await agentAsks(u.w.srv, u.sessions.devtool!.lease, conv);

  const { viewport, isMobile, hasTouch, deviceScaleFactor, userAgent } = info.project.use;
  const phone = await browser.newContext({ viewport, isMobile, hasTouch, deviceScaleFactor, userAgent, storageState: await context.storageState() });
  const tab = await phone.newPage();
  const cdp = await phone.newCDPSession(tab);
  try {
    let warmed = false;
    for (const row of ROWS) {
      // Given a mid-range phone profile with CPU slowed 4 times on the <network> profile
      // When the app starts <start>
      if (row.start === "warm from IndexedDB" && !warmed) {
        await warmUp(tab, origin);
        warmed = true;
      }
      for (const screen of SCREENS) {
        const loads: Useful[] = [];
        for (let trial = 0; trial < TRIALS[row.start]; trial++) {
          await tab.goto("about:blank");
          if (row.start === "cold with an empty cache") await emptyCache(cdp, origin);
          const profile = await phoneProfile(browser, phone, tab, row.network, origin);
          try {
            await tab.goto(`${origin}${screen.path}`, { waitUntil: "commit" });
            loads.push(await useful(tab, 30_000));
          } finally {
            await profile.off();
          }
        }
        const best = loads.reduce((a, b) => (b.tfus < a.tfus ? b : a));
        const label = `${screen.name}, ${row.network}, ${row.start}: tfus ${loads.map((l) => l.tfus.toFixed(0)).join(" ")} ms`;
        info.annotations.push({ type: "tfus", description: label });

        // Then the rail and Now are useful within <budget>
        expect.soft(best.tfus, label).toBeLessThanOrEqual(row.budget);
        // warm, the screen came from the device: no API answer had arrived when it was useful; cold, it waited for its data
        const answered = Object.entries(best.api).filter(([, end]) => end <= best.tfus).map(([path]) => path);
        if (row.start === "warm from IndexedDB") expect.soft(answered, `${label}: API answers before the mark`).toEqual([]);
        else expect.soft(answered, `${label}: API answers before the mark`).toContain(screen.data);
        // and the screen shows the owner's data
        await expect(screen.shows(tab)).toBeVisible({ timeout: 30_000 });
        await info.attach(`${screen.name} (${row.network}, ${row.start})`, { body: await tab.screenshot(), contentType: "image/png" });
      }
    }
  } finally {
    await phone.close();
  }
});

/** Install the app on the phone and let it keep its offline copy: both screens opened, the worker in control, the copy full. */
async function warmUp(tab: Page, origin: string): Promise<void> {
  for (const screen of SCREENS) {
    await tab.goto(`${origin}${screen.path}`);
    await expect(screen.shows(tab)).toBeVisible({ timeout: 30_000 });
  }
  await installed(tab);
  await expect
    .poll(async () => {
      const held = await stored(tab);
      const messages = Object.values(held?.messages ?? {}).reduce((a, b) => a + b, 0);
      return Boolean(held?.meta.includes("now") && held.conversations >= KEPT_CONVERSATIONS && messages >= KEPT_CONVERSATIONS * KEPT_MESSAGES);
    }, { timeout: 120_000, message: "the offline copy holds Now and 20 conversations with 200 messages each" })
    .toBe(true);
}
