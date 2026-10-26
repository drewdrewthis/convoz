import { agentPost, convoz } from "../lib/chat.ts";
import { clientId } from "../lib/machines.ts";
import { must } from "../lib/owner.ts";
import { expect, scenario, test } from "../lib/scenario.ts";
import { agentAsks, snoozeAsk } from "../lib/asks.ts";
import { MASKS } from "../lib/prototype-seed.ts";
import { AGENTS, LIVE, NOT_IDLE, ONLINE_IDLE, keepActual, maskPercent, protoWorld, readyForShot, reportStatuses, seedOpenAsks, seedPrototype, seedRailExtras, starAndMute } from "../lib/prototype-seed.ts";

/*
 * PROTOTYPE PARITY: the owner's verdict on the phone UI was "Why doesn't it have 1:1 pixel perfect match with the prototype?".
 * Each scenario seeds the prototype's sample data, opens one phone screen at 390x800, and compares it, in light and in dark, with the
 * frame of the v41 prototype (Iris) captured by tools/capture-prototype.mjs into visual/prototype/<screen>-<scheme>.png (2x).
 *
 * The comparison is Playwright's toHaveScreenshot: at most 2% of the pixels may differ (maxDiffPixelRatio 0.02) at a per-pixel colour
 * threshold of 0.2. Rectangles in visual/masks.json are painted grey over both images. They cover what the app does not have yet
 * (no backend): the Search, Show details, Star, Mute, Attach and Voice controls, the Snoozed and Answered chips, the ask and app
 * cards, agent status (the Working summary, status lines, ask chips, avatars) and the Invite agent button; the muted look of
 * "Team updates"; the badge on Now (it counts asks); the @ menu on New conversation (the app lists the agents instead); and every time.
 * The two starred conversations are read, not starred, in the reference (no stars).
 *
 * Routes: /chats is Conversations, /chats/new is New conversation, /crew is Crew, / is Now. Locators are not used: the shot is the check.
 */

test.use({ deviceScaleFactor: 2 });

/** No screen may hide more than its share of the frame behind grey boxes, so the masks cannot grow without this number changing. */
/** now: 25, because the owner (msg 275) centred the wordmark and moved the All clear line under it, which the prototype frame does not show. */
const MASK_CAP: Record<string, number> = { now: 25, "now-unread": 10, "now-asks": 10, conversations: 10, "conversation-thread": 10, thread: 10, "new-conversation": 10, crew: 20, rail: 10, "crew-status": 20 };

const SHOT = { maxDiffPixelRatio: 0.02, threshold: 0.2, animations: "disabled", caret: "hide", scale: "device" } as const;

/** Light then dark, each against its own reference: the prototype's frame, or, for a screen the owner changed on purpose, a reviewed frame of the app. */
async function matchesBoth(page: import("@playwright/test").Page, screen: string, from: "prototype" | "app" = "prototype"): Promise<void> {
  expect(maskPercent(screen), `the masks of ${screen} cover too much of the frame`).toBeLessThanOrEqual(MASK_CAP[screen]!);
  for (const scheme of ["light", "dark"] as const) {
    await readyForShot(page, screen, scheme);
    await keepActual(page, `${screen}-${scheme}`);
    await expect(page).toHaveScreenshot([from, `${screen}-${scheme}.png`], SHOT);
  }
}

scenario("On a phone Now matches the prototype", { tag: ["@browser", "@phone"] }, async ({ server, page, context }, info) => {
  info.setTimeout(180_000);
  // Background: the prototype's agents and conversations. Given nothing waits for the owner
  const u = await protoWorld({ server, page, context }, { agents: AGENTS, live: LIVE });
  await seedPrototype(u);

  // When the owner opens Now on a phone
  await page.goto(`${u.w.srv.origin}/`);
  // Owner, conv 1, msg 535: "it says nothing needs me, but there are a lot of unseen responses". The prototype's conversations are unread, so Now
  // says "No decisions waiting" without the wordmark (msg 562: the digest must be in view) and lists them; the frame is a reviewed one of the app, not the prototype's.
  await expect(page.getByText("No decisions waiting")).toBeVisible();

  // Then it matches the app frame in light and in dark
  await matchesBoth(page, "now-unread", "app");
});

scenario("On a phone Now with asks matches the prototype", { tag: ["@browser", "@phone"] }, async ({ server, page, context }, info) => {
  info.setTimeout(180_000);
  // Background: the prototype's agents and conversations. Given "night-watch" asked an urgent "Close the incident?" and "devtool" asked "Push the 8642 fix to staging?"
  const u = await protoWorld({ server, page, context }, { agents: AGENTS, live: LIVE });
  const ids = await seedPrototype(u);
  const lease = (h: string) => u.sessions[h]!.lease;
  await agentAsks(u.w.srv, lease("night-watch"), ids["Ops reports"]!, {
    question: "Close the incident?",
    urgent: true,
    rec: ["Close it", "the error rate is back to 0.3% and has held for 20 minutes."],
    alts: [["Keep open", "the 4.1% peak is recent, and one more quiet window would make me surer."]],
  });
  await agentAsks(u.w.srv, lease("devtool"), ids["Bug #8642 · null check fix"]!, {
    question: "Push the 8642 fix to staging?",
    rec: ["Push it", "the new test fails before the fix and passes after, and I reproduced the bug twice."],
    alts: [["Hold", "staging is busy with the export run, so waiting avoids a noisy deploy."]],
  });
  // And one ask is snoozed
  const later = await agentAsks(u.w.srv, lease("scrum-master"), ids["scrum-master"]!, { question: "Pick the next sprint goal", rec: ["Search filters", "it unblocks two lanes."], alts: [["Flaky tests", "they cost about 40 minutes of CI a day."]] });
  must(await snoozeAsk(u.w.owner, later, { preset: "tomorrow", tz: "UTC" }), "snooze the sprint ask");

  // When the owner opens Now on a phone
  await page.goto(`${u.w.srv.origin}/`);
  await expect(page.getByRole("article", { name: "Close the incident?" })).toBeVisible();

  // Then it matches the prototype in light and in dark
  await matchesBoth(page, "now-asks", "app");
});

scenario("On a phone the Conversations list matches the prototype", { tag: ["@browser", "@phone"] }, async ({ server, page, context }, info) => {
  info.setTimeout(180_000);
  // Background: the prototype's agents and conversations
  const u = await protoWorld({ server, page, context }, { agents: AGENTS, live: LIVE });
  await seedPrototype(u);

  // When the owner opens Conversations on a phone
  await page.goto(`${u.w.srv.origin}/chats`);
  await expect(page.getByRole("heading", { name: "Why did the nightly export get slower?" })).toBeVisible();

  // Then it matches the reviewed app frame in light and in dark: the owner had the phone list redone (conv 132 msg 3322), chevron and
  // counts in a right column, a round "+"
  await matchesBoth(page, "conversations", "app");
});

scenario("On a phone a conversation matches the prototype", { tag: ["@browser", "@phone"] }, async ({ server, page, context }, info) => {
  info.setTimeout(180_000);
  // Background: the prototype's agents and conversations
  const u = await protoWorld({ server, page, context }, { agents: AGENTS, live: LIVE });
  const ids = await seedPrototype(u);

  // When the owner opens "Why did the nightly export get slower?" on a phone
  await page.goto(`${u.w.srv.origin}/chats/${ids["Why did the nightly export get slower?"]}`);
  await expect(page.getByRole("log", { name: "Messages" }).getByRole("article")).toHaveCount(2);
  await page.getByRole("log", { name: "Messages" }).evaluate((e) => (e.scrollTop = 0));

  // Then it matches the prototype in light and in dark
  await matchesBoth(page, "conversation-thread");
});

scenario("On a phone a thread matches the prototype", { tag: ["@browser", "@phone"] }, async ({ server, page, context }, info) => {
  info.setTimeout(180_000);
  // Background: the prototype's agents and conversations, and the thread under night-watch's "Deploy finished" in Ops reports
  const u = await protoWorld({ server, page, context }, { agents: AGENTS, live: LIVE });
  const ops = (await seedPrototype(u))["Ops reports"]!;
  const as = (handle: string) => u.sessions[handle]!.lease;
  const root = must(await agentPost(u.w.srv, as("night-watch"), ops, "Deploy finished at 5:29. I'm watching the error rate."), "root", 201).json().id as number;
  const reply = (lease: string, body: string, format?: string) => agentPost(u.w.srv, lease, ops, body, { thread_root_id: root, ...(format ? { format } : {}) });
  must(await reply(as("usage-bot"), "Token spend is flat across the deploy\\. __No change__ needed\\. The docs lane used ||1\\.1M tokens|| today\\.", "markdownv2"), "reply 1", 201);
  must(await u.w.owner.client.post(`/api/conversations/${ops}/messages`, { client_id: clientId(), body: "Ping me if the error rate goes over 2%.", thread_root_id: root }), "reply 2", 201);
  must(await reply(as("night-watch"), "Will do. I will post here first."), "reply 3", 201);

  // When the owner opens the thread of "Deploy finished at 5:29. I'm watching the error rate." in "Ops reports" on a phone
  await page.goto(`${u.w.srv.origin}/chats/${ops}`);
  // the thread is drawn under its root (issue 61), with its reply box open
  const thread = page.getByRole("region", { name: "Thread: Deploy finished at 5:29" });
  await thread.getByRole("button", { name: "Reply in thread", exact: true }).click();
  await expect(thread.getByRole("article")).toHaveCount(3);

  // Then it matches the prototype in light and in dark
  await page.mouse.move(0, 0); // no hover state on a row
  await matchesBoth(page, "thread");
});

scenario("On a phone New conversation matches the prototype", { tag: ["@browser", "@phone"] }, async ({ server, page, context }, info) => {
  info.setTimeout(180_000);
  // Background: the prototype's agents and conversations
  const u = await protoWorld({ server, page, context }, { agents: AGENTS, live: LIVE });
  await seedPrototype(u);

  // When the owner opens New conversation on a phone
  await page.goto(`${u.w.srv.origin}/chats/new`);
  await expect(page.getByRole("heading", { name: "New conversation", exact: true })).toBeVisible();
  await expect(page.getByText("Type @ to bring in an agent.")).toBeVisible();

  // Then it matches the prototype in light and in dark
  await matchesBoth(page, "new-conversation");
});

scenario("On a phone Crew matches the prototype", { tag: ["@browser", "@phone"] }, async ({ server, page, context }, info) => {
  info.setTimeout(180_000);
  // Given every agent is idle
  const u = await protoWorld({ server, page, context }, { agents: AGENTS, live: ONLINE_IDLE, disabled: NOT_IDLE });

  // When the owner opens Crew on a phone
  await page.goto(`${u.w.srv.origin}/crew`);
  await expect(page.getByRole("heading", { name: "Crew", exact: true })).toBeVisible();

  // Then it matches the prototype in light and in dark
  await matchesBoth(page, "crew", "app");
});

scenario("On a phone the rail matches the prototype", { tag: ["@browser", "@phone"] }, async ({ server, page, context }, info) => {
  info.setTimeout(180_000);
  // Background: the prototype's agents and conversations
  const u = await protoWorld({ server, page, context }, { agents: AGENTS, live: LIVE });
  const ids = await seedPrototype(u);

  // Given the owner starred "assistant" and "Ops reports" and muted "Team updates"
  await starAndMute(u, ids);

  // When the owner opens the rail on a phone
  await page.goto(`${u.w.srv.origin}/chats`);
  await expect(page.getByRole("heading", { name: "Ops reports" })).toBeVisible();

  // Then it matches the reviewed app frame in light and in dark (the phone list redone, conv 132 msg 3322)
  await matchesBoth(page, "rail", "app");
});

scenario("On a phone Crew with agent status matches the prototype", { tag: ["@browser", "@phone"] }, async ({ server, page, context, dataDir }, info) => {
  info.setTimeout(180_000);
  // Background: the prototype's agents and conversations (docs is live too: the prototype shows it working)
  const u = await protoWorld({ server, page, context }, { agents: AGENTS, live: [...LIVE, "docs", "orchardist"], dataDir });

  // Given the agents report the status the prototype shows
  await reportStatuses(u);
  await seedOpenAsks(u, dataDir);

  // When the owner opens Crew on a phone
  await page.goto(`${u.w.srv.origin}/crew`);
  await expect(page.getByRole("heading", { name: "Crew", exact: true })).toBeVisible();
  await expect(page.getByText("Waiting on you · OK on the Slack draft")).toBeVisible();

  // Then it matches the prototype in light and in dark
  await matchesBoth(page, "crew-status", "app");
});

// ---- desktop: one element of the 1280x800 window, as the prototype's rail and Crew dock are shot ----------------------------------

const DESKTOP_CAP: Record<string, number> = { "rail-desktop": 10 };

/** The share of a w x h element that the grey boxes of a screen cover (overlaps counted once), in percent. */
function elementMaskPercent(screen: string, w: number, h: number): number {
  const covered = new Set<number>();
  for (const r of MASKS[screen] ?? []) for (let x = r.x; x < Math.min(w, r.x + r.w); x++) for (let y = r.y; y < Math.min(h, r.y + r.h); y++) covered.add(y * w + x);
  return (100 * covered.size) / (w * h);
}

/** Light then dark: `el` against the prototype's element of the same screen (w x h), with the same grey boxes inside it. */
async function matchesElement(page: import("@playwright/test").Page, screen: string, el: import("@playwright/test").Locator, w: number, h: number, window: number): Promise<void> {
  expect(elementMaskPercent(screen, w, h), `the masks of ${screen} cover too much of the element`).toBeLessThanOrEqual(DESKTOP_CAP[screen]!);
  for (const scheme of ["light", "dark"] as const) {
    // The window is 1280 wide in both Playwright projects: the phone project widens its window for these scenarios.
    await page.setViewportSize({ width: 1280, height: window });
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" });
    await page.evaluate(() => document.fonts.ready);
    await el.evaluate(
      (node, rects) => {
        node.querySelectorAll("[data-mask]").forEach((d) => d.remove());
        if (getComputedStyle(node).position === "static") (node as HTMLElement).style.position = "relative";
        for (const r of rects) {
          const d = document.createElement("div");
          d.setAttribute("data-mask", r.name);
          d.style.cssText = `position:absolute;z-index:2147483647;background:#808080;left:${r.x}px;top:${r.y}px;width:${r.w}px;height:${r.h}px`;
          node.appendChild(d);
        }
      },
      MASKS[screen] ?? [],
    );
    // Headless Chromium draws a frame only when a shot asks for one, and the first frame after the colour scheme changes repaints the
    // whole desktop canvas (its window-sized gradients): seconds of software raster on a loaded machine. This shot pays for that draw
    // (and keeps the app shot when PARITY_ACTUAL_DIR is set), so the compared shot starts on a page that has drawn the scheme.
    const dir = process.env.PARITY_ACTUAL_DIR;
    await el.screenshot({ path: dir ? `${dir}/${screen}-${scheme}.png` : undefined, animations: "disabled", caret: "hide", scale: "device" });
    await expect(el).toHaveScreenshot(["prototype", `${screen}-${scheme}.png`], SHOT);
  }
}

scenario("On a desktop the rail matches the prototype", { tag: ["@browser"] }, async ({ server, page, context, dataDir }, info) => {
  info.setTimeout(180_000);
  // Background: the prototype's agents and conversations
  const u = await protoWorld({ server, page, context }, { agents: AGENTS, live: LIVE, dataDir });
  await seedRailExtras(u, dataDir);
  const ids = await seedPrototype(u);

  // Given the owner starred "assistant" and "Ops reports" and muted "Team updates"
  await starAndMute(u, ids);

  // When the owner opens the rail on a desktop (the prototype's sidebar is 742 high inside its window)
  await page.setViewportSize({ width: 1280, height: 743 });
  await page.goto(`${u.w.srv.origin}/`);
  const rail = page.getByRole("navigation", { name: "Conversations" });
  await expect(rail.getByRole("button", { name: /Older · 6/ })).toBeVisible();

  // Then it matches the prototype in light and in dark
  await matchesElement(page, "rail-desktop", rail, 240, 742, 743);
});
