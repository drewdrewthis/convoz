import type { Page } from "@playwright/test";
import { makeBootstrapLink } from "../lib/admin.ts";
import { agentAsks, snoozeAsk } from "../lib/asks.ts";
import { agentPost, convoz } from "../lib/chat.ts";
import { clientId } from "../lib/machines.ts";
import { bootstrapOwner, must } from "../lib/owner.ts";
import { AGENTS, LIVE, NOT_IDLE, ONLINE_IDLE, reportStatuses, seedOpenAsks, seedPrototype, starAndMute } from "../lib/prototype-seed.ts";
import { frozenWorld, matchesItself } from "../lib/regress.ts";
import { expect, scenario, test } from "../lib/scenario.ts";

/*
 * APP REGRESSION: specs/features/app-regress.feature. The app against its own reviewed frames, so a refactor of the UI code (atoms,
 * features, CSS moves) that shifts one element or one pixel fails here. Where prototype-parity.spec.ts compares with the prototype and
 * masks what the app lacks, this spec masks nothing but timings: both clocks are frozen (lib/regress.ts FROZEN_AT), so ages and times are
 * the same on every run. Every screen runs in the "chromium" (1280x720) and the "mobile" (390x844) project, in light and in dark.
 * References: visual/regress/<project>/. Writing them is a human act (REGRESS_WRITE=1, visual/regress/README.md).
 */

test.use({ deviceScaleFactor: 1, timezoneId: "UTC", locale: "en-US" });

const world = (fx: Parameters<typeof frozenWorld>[0]) => frozenWorld(fx, { agents: AGENTS, live: LIVE });

const ready = async (page: Page, heading: string) => expect(page.getByRole("heading", { name: heading, exact: true })).toBeVisible();

scenario("Now and the Conversations list keep their look", { tag: ["@browser"] }, async ({ server, page, context, testApi }, info) => {
  info.setTimeout(240_000);
  // Background: the prototype's agents and conversations, with both clocks frozen
  const u = await world({ server, page, context, testApi });
  await seedPrototype(u);

  // When the owner opens Now, and then Conversations
  await page.goto(`${u.w.srv.origin}/`);
  await expect(page.getByText("No decisions waiting")).toBeVisible();
  // Then each matches its own frame in light and in dark
  await matchesItself(page, info, "now-unread");
  await page.goto(`${u.w.srv.origin}/chats`);
  await expect(page.getByRole("heading", { name: "Why did the nightly export get slower?" })).toBeVisible();
  await matchesItself(page, info, "conversations");
});

scenario("A conversation, its composer and its thread keep their look", { tag: ["@browser"] }, async ({ server, page, context, testApi }, info) => {
  info.setTimeout(240_000);
  // Background: the prototype's agents and conversations, and the thread under night-watch's "Deploy finished" in Ops reports
  const u = await world({ server, page, context, testApi });
  const ids = await seedPrototype(u);
  const ops = ids["Ops reports"]!;
  const as = (handle: string) => u.sessions[handle]!.lease;
  const root = must(await agentPost(u.w.srv, as("night-watch"), ops, "Deploy finished at 5:29. I'm watching the error rate."), "root", 201).json().id as number;
  must(await agentPost(u.w.srv, as("usage-bot"), ops, "Token spend is flat across the deploy\\. __No change__ needed\\.", { thread_root_id: root, format: "markdownv2" }), "reply 1", 201);
  must(await u.w.owner.client.post(`/api/conversations/${ops}/messages`, { client_id: clientId(), body: "Ping me if the error rate goes over 2%.", thread_root_id: root }), "reply 2", 201);
  must(await agentPost(u.w.srv, as("night-watch"), ops, "Will do. I will post here first.", { thread_root_id: root }), "reply 3", 201);

  // When the owner opens "Why did the nightly export get slower?"
  await page.goto(`${u.w.srv.origin}/chats/${ids["Why did the nightly export get slower?"]}`);
  await expect(page.getByRole("log", { name: "Messages" }).getByRole("article")).toHaveCount(2);
  await page.getByRole("log", { name: "Messages" }).evaluate((e) => (e.scrollTop = 0));
  // Then it matches its frame, and so does the composer with a draft in it
  await matchesItself(page, info, "conversation");
  await page.getByRole("textbox", { name: /^Message/ }).fill("Thanks. Please open the PR for #415 and ping me when the export is green.");
  await matchesItself(page, info, "composer-with-text");

  // And when the owner opens the thread of "Deploy finished at 5:29. I'm watching the error rate." in "Ops reports", it matches its frame
  await page.goto(`${u.w.srv.origin}/chats/${ops}`);
  await page.getByRole("button", { name: /^Open thread, 3 replies/ }).click();
  await expect(page.getByRole("log", { name: "Thread messages" }).getByRole("article")).toHaveCount(4);
  await matchesItself(page, info, "thread");
});

scenario("New conversation, search and settings keep their look", { tag: ["@browser"] }, async ({ server, page, context, testApi }, info) => {
  info.setTimeout(240_000);
  // Background: the prototype's agents and conversations
  const u = await world({ server, page, context, testApi });
  await seedPrototype(u);

  // When the owner opens New conversation
  await page.goto(`${u.w.srv.origin}/chats/new`);
  await ready(page, "New conversation");
  await expect(page.getByText("Type @ to bring in an agent.")).toBeVisible();
  await matchesItself(page, info, "new-conversation");

  // And opens the search overlay, empty and then with "cache" typed (the status line carries the query's duration, so it is masked)
  await page.goto(`${u.w.srv.origin}/chats`);
  await page.getByRole("button", { name: "Search", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Search" });
  await expect(dialog).toBeVisible();
  await matchesItself(page, info, "search-empty");
  await dialog.getByRole("combobox", { name: "Search" }).fill("cache");
  await expect(dialog.getByRole("listbox", { name: "Search results" }).getByRole("option").first()).toBeVisible();
  await matchesItself(page, info, "search-results", { mask: [dialog.getByRole("status")], ignore: "[role=status]" });

  // And opens Settings
  await page.goto(`${u.w.srv.origin}/settings`);
  await ready(page, "Settings");
  await matchesItself(page, info, "settings");
});

scenario("The rail with stars and a mute keeps its look", { tag: ["@browser"] }, async ({ server, page, context, testApi }, info) => {
  info.setTimeout(240_000);
  // Background: the prototype's agents and conversations
  const u = await world({ server, page, context, testApi });
  const ids = await seedPrototype(u);

  // Given the owner starred "assistant" and "Ops reports" and muted "Team updates"
  await starAndMute(u, ids);

  // When the owner opens the rail, Then it matches its frame in light and in dark
  await page.goto(`${u.w.srv.origin}/chats`);
  await expect(page.getByRole("heading", { name: "Ops reports" })).toBeVisible();
  await matchesItself(page, info, "rail");
});

scenario("Now with asks and the snooze sheet keep their look", { tag: ["@browser"] }, async ({ server, page, context, testApi }, info) => {
  info.setTimeout(240_000);
  // Background: the prototype's agents and conversations. Given two open asks and one snoozed
  const u = await world({ server, page, context, testApi });
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
  const later = await agentAsks(u.w.srv, lease("scrum-master"), ids["scrum-master"]!, { question: "Pick the next sprint goal", rec: ["Search filters", "it unblocks two lanes."], alts: [["Flaky tests", "they cost about 40 minutes of CI a day."]] });
  must(await snoozeAsk(u.w.owner, later, { preset: "tomorrow", tz: "UTC" }), "snooze the sprint ask");

  // When the owner opens Now, Then it matches its frame
  await page.goto(`${u.w.srv.origin}/`);
  const card = page.getByRole("article", { name: "Close the incident?" });
  await expect(card).toBeVisible();
  await matchesItself(page, info, "now-asks");

  // And when the owner opens the Snooze choices of that ask, the sheet matches its frame
  await card.getByRole("group", { name: "Ask actions" }).getByRole("button", { name: "Snooze" }).click();
  await expect(page.getByRole("menuitem", { name: "1 hour" })).toBeVisible();
  await matchesItself(page, info, "snooze-sheet");
});

scenario("Now with a waiting plan item keeps its look", { tag: ["@browser"] }, async ({ server, page, context, testApi }, info) => {
  info.setTimeout(240_000);
  // Background: the prototype's agents and conversations. Given "devtool" waits on the owner for "Approve the staging push"
  const u = await world({ server, page, context, testApi });
  const ids = await seedPrototype(u);
  const dev = await convoz(u.w.box, u.sessions.devtool!.sid, ["plan", String(ids["Bug #8642 · null check fix"]!), "--doing", "Fixing the null check", "--waiting", "Approve the staging push"]);
  expect({ code: dev.code, stderr: dev.stderr }).toEqual({ code: 0, stderr: "" });

  // When the owner opens Now, Then it matches its frame
  await page.goto(`${u.w.srv.origin}/`);
  await expect(page.getByRole("region", { name: "Waiting on you" })).toBeVisible();
  await matchesItself(page, info, "now-waiting");
});

scenario("Crew keeps its look", { tag: ["@browser"] }, async ({ server, page, context, testApi }, info) => {
  info.setTimeout(240_000);
  // Given every agent is idle
  const u = await frozenWorld({ server, page, context, testApi }, { agents: AGENTS, live: ONLINE_IDLE, disabled: NOT_IDLE });

  // When the owner opens Crew, Then it matches its frame
  await page.goto(`${u.w.srv.origin}/crew`);
  await ready(page, "Crew");
  await matchesItself(page, info, "crew");
});

scenario("Crew with agent status keeps its look", { tag: ["@browser"] }, async ({ server, page, context, dataDir, testApi }, info) => {
  info.setTimeout(240_000);
  // Background: the prototype's agents, with docs and orchardist live too
  const u = await frozenWorld({ server, page, context, testApi }, { agents: AGENTS, live: [...LIVE, "docs", "orchardist"], dataDir });

  // Given the agents report the status the prototype shows, and have open asks
  await reportStatuses(u);
  await seedOpenAsks(u, dataDir);

  // When the owner opens Crew, Then it matches its frame
  await page.goto(`${u.w.srv.origin}/crew`);
  await ready(page, "Crew");
  await expect(page.getByText("Waiting on you · OK on the Slack draft")).toBeVisible();
  await matchesItself(page, info, "crew-status");
});

scenario("The desktop rail and conversation layout keeps its look", { tag: ["@browser"] }, async ({ server, page, context, testApi }, info) => {
  info.setTimeout(240_000);
  // The layout is the desktop's: the phone project has no rail beside the conversation
  test.skip(info.project.name === "mobile", "a desktop layout, shot in the chromium project");
  // Background: the prototype's agents and conversations, with the rail's stars and mute
  const u = await world({ server, page, context, testApi });
  const ids = await seedPrototype(u);
  await starAndMute(u, ids);

  // When the owner opens a conversation in a 1280x800 window
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`${u.w.srv.origin}/chats/${ids["Why did the nightly export get slower?"]}`);
  await expect(page.getByRole("log", { name: "Messages" }).getByRole("article")).toHaveCount(2);
  await expect(page.getByRole("navigation", { name: "Conversations" })).toBeVisible();

  // Then the rail beside the conversation matches its frame
  await matchesItself(page, info, "desktop-rail-conversation");
});

scenario("Sign in and the first onboarding screen keep their look", { tag: ["@browser"] }, async ({ server, page }, info) => {
  info.setTimeout(240_000);
  // Background: a server with an owner, and a browser that is not signed in
  const srv = await server({ host: "localhost", adminSocket: true });
  await bootstrapOwner(srv);

  // When the browser opens the sign-in page, Then it matches its frame
  await page.goto(`${srv.origin}/signin`);
  await expect(page.getByRole("button", { name: "Sign in with a passkey" })).toBeVisible();
  await matchesItself(page, info, "signin");

  // And when it opens a bootstrap link, the first onboarding screen matches its frame
  const link = await makeBootstrapLink(srv.adminSocket!);
  await page.goto(`${srv.origin}/bootstrap#${link.token}`);
  await expect(page.getByRole("button", { name: "Register passkey" })).toBeVisible();
  await matchesItself(page, info, "onboarding-first");
});
