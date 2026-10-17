import { agentPost } from "../lib/chat.ts";
import { clientId } from "../lib/machines.ts";
import { must } from "../lib/owner.ts";
import { expect, scenario, test } from "../lib/scenario.ts";
import { AGENTS, LIVE, NOT_IDLE, ONLINE_IDLE, keepActual, maskPercent, protoWorld, readyForShot, seedPrototype } from "../lib/prototype-seed.ts";

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
const MASK_CAP: Record<string, number> = { now: 10, conversations: 10, "conversation-thread": 10, thread: 10, "new-conversation": 10, crew: 20 };

const SHOT = { maxDiffPixelRatio: 0.02, threshold: 0.2, animations: "disabled", caret: "hide", scale: "device" } as const;

/** Light then dark, each against its own reference. */
async function matchesBoth(page: import("@playwright/test").Page, screen: string): Promise<void> {
  expect(maskPercent(screen), `the masks of ${screen} cover too much of the frame`).toBeLessThanOrEqual(MASK_CAP[screen]!);
  for (const scheme of ["light", "dark"] as const) {
    await readyForShot(page, screen, scheme);
    await keepActual(page, `${screen}-${scheme}`);
    await expect(page).toHaveScreenshot(`${screen}-${scheme}.png`, SHOT);
  }
}

scenario("On a phone Now matches the prototype", { tag: ["@browser", "@phone"] }, async ({ server, page, context }, info) => {
  info.setTimeout(180_000);
  // Background: the prototype's agents and conversations. Given nothing waits for the owner
  const u = await protoWorld({ server, page, context }, { agents: AGENTS, live: LIVE });
  await seedPrototype(u);

  // When the owner opens Now on a phone
  await page.goto(`${u.w.srv.origin}/`);
  await expect(page.getByText("All clear. Nothing needs you.")).toBeVisible();

  // Then it matches the prototype in light and in dark
  await matchesBoth(page, "now");
});

scenario("On a phone the Conversations list matches the prototype", { tag: ["@browser", "@phone"] }, async ({ server, page, context }, info) => {
  info.setTimeout(180_000);
  // Background: the prototype's agents and conversations
  const u = await protoWorld({ server, page, context }, { agents: AGENTS, live: LIVE });
  await seedPrototype(u);

  // When the owner opens Conversations on a phone
  await page.goto(`${u.w.srv.origin}/chats`);
  await expect(page.getByRole("heading", { name: "Why did the nightly export get slower?" })).toBeVisible();

  // Then it matches the prototype in light and in dark
  await matchesBoth(page, "conversations");
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
  await page.getByRole("button", { name: /^Open thread, 3 replies/ }).click();
  await expect(page.getByRole("dialog", { name: "Thread in Ops reports" }).getByRole("log", { name: "Thread messages" }).getByRole("article")).toHaveCount(4);

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
  await matchesBoth(page, "crew");
});
