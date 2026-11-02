import type { Locator, Page } from "@playwright/test";
import { makeBootstrapLink } from "../lib/admin.ts";
import { QUESTION, agentAsks, answerAsk, markAsk, openFold, ownerRepliesIn, snoozeAsk } from "../lib/asks.ts";
import { agentPost, convoz, createConversation } from "../lib/chat.ts";
import { clientId, mintSession, requestMachine, seedUserCodes } from "../lib/machines.ts";
import { webauthn } from "../lib/webauthn-browser.ts";
import { bootstrapOwner, must } from "../lib/owner.ts";
import { AGENTS, LIVE, NOT_IDLE, ONLINE_IDLE, reportStatuses, seedOpenAsks, seedPrototype, starAndMute } from "../lib/prototype-seed.ts";
import { FROZEN_AT, frozenWorld, matchesItself } from "../lib/regress.ts";
import { expect, scenario, test } from "../lib/scenario.ts";
import { agentJoins } from "../lib/triage.ts";
import { asAgent } from "../lib/wp3.ts";

/*
 * APP REGRESSION: specs/features/app-regress.feature. The app against its own reviewed frames, so a refactor of the UI code (atoms,
 * features, CSS moves) that shifts one element or one pixel fails here. Where prototype-parity.spec.ts compares with the prototype and
 * masks what the app lacks, this spec masks nothing but timings: both clocks are frozen (lib/regress.ts FROZEN_AT), so ages and times are
 * the same on every run. Every screen runs in the "chromium" (1280x720) and the "mobile" (390x844) project, in light and in dark.
 * References: visual/regress/<project>/. Writing them is a human act (REGRESS_WRITE=1, visual/regress/README.md).
 */

test.use({ deviceScaleFactor: 1, timezoneId: "UTC", locale: "en-US" });

const world = (fx: Parameters<typeof frozenWorld>[0]) => frozenWorld(fx, { agents: AGENTS, live: LIVE });

/** Sets text that carries the real day or time (a server stamp from before the clocks froze) to a fixed one, so the width it takes is the same on every day. */
const pin = async (where: Locator, text: string) => where.evaluateAll((all, t) => all.forEach((e) => (e.textContent = t)), text);

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
  // the thread is drawn under its root (issue 61): its reply box open, as the drawer was
  const thread = page.getByRole("region", { name: "Thread: Deploy finished at 5:29" });
  await thread.getByRole("button", { name: "Reply in thread", exact: true }).click();
  await expect(thread.getByRole("article")).toHaveCount(3);
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
  await card.getByRole("group", { name: "Actions" }).getByRole("button", { name: "Snooze" }).click();
  await expect(page.getByRole("menuitem", { name: "1 hour" })).toBeVisible();
  await matchesItself(page, info, "snooze-sheet");
});

scenario("Now with a replied ask and an updated ask keeps its look", { tag: ["@browser"] }, async ({ server, page, context, testApi }, info) => {
  info.setTimeout(240_000);
  // Background: the prototype's agents and conversations. Given an open ask the owner replied to, and an open ask updated after the owner's questions
  const u = await world({ server, page, context, testApi });
  const ids = await seedPrototype(u);
  const lease = (h: string) => u.sessions[h]!.lease;
  const waiting = await agentAsks(u.w.srv, lease("devtool"), ids["Bug #8642 · null check fix"]!, {
    question: "Push the 8642 fix to staging?",
    rec: ["Push it", "the new test fails before the fix and passes after, and I reproduced the bug twice."],
    alts: [["Hold", "staging is busy with the export run, so waiting avoids a noisy deploy."]],
  });
  await ownerRepliesIn(u.w.owner, ids["Bug #8642 · null check fix"]!, waiting, "Is it behind a flag, and who reviewed it? Why one PR and not two?");
  const updated = await agentAsks(u.w.srv, lease("night-watch"), ids["Ops reports"]!, {
    question: "Close the incident?",
    rec: ["Close it", "the error rate is back to 0.3% and has held for 20 minutes."],
    alts: [["Keep open", "the 4.1% peak is recent, and one more quiet window would make me surer."]],
  });
  await ownerRepliesIn(u.w.owner, ids["Ops reports"]!, updated, "What caused the peak?");
  const ran = await convoz(u.w.box, u.sessions["night-watch"]!.sid, ["ask", "--update", String(updated), "--answers", "A bad deploy of the export job caused the peak. It was rolled back at 5:12, and the error rate has held at 0.3% since. The review bot and QA passed on the rollback."]);
  expect({ code: ran.code, stderr: ran.stderr }).toEqual({ code: 0, stderr: "" });

  // When the owner opens Now, Then it matches its frame, with the section "You replied · waiting on the agent" and the updated ask with its answers
  await page.goto(`${u.w.srv.origin}/`);
  await expect(page.getByRole("article", { name: "Close the incident?" })).toContainText("A bad deploy of the export job caused the peak.");
  await expect(page.locator("#replied")).toContainText("Push the 8642 fix to staging?");
  // And the row leads with the owner's own reply, the ask under it (owner, msg 2056)
  await expect(page.locator("#replied [data-replied] > span").first()).toHaveText("Is it behind a flag, and who reviewed it? Why one PR and not two?");
  await expect(page.locator("#replied")).toContainText("On: Push the 8642 fix to staging?");
  await matchesItself(page, info, "now-replied");
});

scenario("An empty Now and its open folds keep their look", { tag: ["@browser"] }, async ({ server, page, context, testApi }, info) => {
  info.setTimeout(240_000);
  // Background: one conversation with an answered ask, a dismissed ask and a snoozed ask, and nothing else waiting
  const u = await world({ server, page, context, testApi });
  const conv = await createConversation(u.w.owner, { title: "Ship search filters", participants: ["devtool"] });
  const lease = u.sessions.devtool!.lease;
  must(await answerAsk(u.w.owner, await agentAsks(u.w.srv, lease, conv, { question: "Answer the answered question?" })), "answer");
  must(await markAsk(u.w.owner, await agentAsks(u.w.srv, lease, conv, { question: "Answer the dismissed question?" }), "dismiss"), "dismiss");
  must(await snoozeAsk(u.w.owner, await agentAsks(u.w.srv, lease, conv, { question: "Answer the snoozed question?" }), { preset: "tomorrow", tz: "UTC" }), "snooze");
  must(await u.w.owner.client.post(`/api/conversations/${conv}/read`, { main_id: 0, all: true }), "read it all");

  // When the owner opens Now, Then the all-clear line and the three fold chips match their frame
  await page.goto(`${u.w.srv.origin}/`);
  await expect(page.getByText("All clear. Nothing needs you.")).toBeVisible();
  await matchesItself(page, info, "now-clear");

  // And when the owner opens the three folds, their rows match theirs
  for (const fold of ["Snoozed", "Answered today", "Dismissed today"]) await openFold(page, fold);
  await expect(page.locator(".foldrows li")).toHaveCount(3);
  await matchesItself(page, info, "now-folds-open");

  // And in the conversation the answered and the dismissed ask are drawn with their state line
  await page.goto(`${u.w.srv.origin}/chats/${conv}`);
  await expect(page.getByText(/^Merge it, by .+$/)).toBeVisible();
  await expect(page.getByText("Dismissed", { exact: true })).toBeVisible();
  await matchesItself(page, info, "ask-states");
});

scenario("Ask items with a draft, an open reply box and in a conversation keep their look", { tag: ["@browser"] }, async ({ server, page, context, testApi }, info) => {
  info.setTimeout(240_000);
  // Background: "devtool" asked a question and asked the owner to review a draft reply; the owner read the conversation
  const u = await world({ server, page, context, testApi });
  const conv = await createConversation(u.w.owner, { title: "Ship search filters", participants: ["devtool"] });
  await agentAsks(u.w.srv, u.sessions.devtool!.lease, conv, {});
  const draft = await convoz(u.w.box, u.sessions.devtool!.sid, ["ask", "--json", "--draft", "Sounds good, Thursday works.", "--original", "Can we meet Thursday?", "--original-from", "Alex · Slack DM", String(conv), "Send this reply to Alex?"]);
  expect({ code: draft.code, stderr: draft.stderr }).toEqual({ code: 0, stderr: "" });
  must(await u.w.owner.client.post(`/api/conversations/${conv}/read`, { main_id: 0, all: true }), "read it all");

  // When the owner opens Now, Then the question and the draft ask, the draft as its context, match their frame
  await page.goto(`${u.w.srv.origin}/`);
  const card = page.getByRole("article", { name: QUESTION });
  await expect(card).toBeVisible();
  await expect(page.getByRole("article", { name: "Send this reply to Alex?" })).toContainText("Draft: Sounds good, Thursday works.");
  await matchesItself(page, info, "now-ask-draft");

  // And when the owner presses Reply and types, the reply box and its Send button match theirs
  await card.getByRole("group", { name: "Actions" }).getByRole("button", { name: "Reply" }).click();
  await card.getByRole("textbox", { name: "Reply to the thread" }).fill("Yes, go ahead");
  await matchesItself(page, info, "now-quick-reply");

  // And in the conversation the same asks are drawn as items, and the item menu matches its frame
  await page.goto(`${u.w.srv.origin}/chats/${conv}`);
  const options = page.getByRole("button", { name: "Item actions" }).first();
  await expect(options).toBeVisible();
  await matchesItself(page, info, "ask-conversation");
  await options.click();
  await expect(page.getByRole("menuitem", { name: "Delete" })).toBeVisible();
  await matchesItself(page, info, "ask-options");
});

scenario("Now with an add to decide and connect requests keeps its look", { tag: ["@browser"] }, async ({ server, page, context, testApi }, info) => {
  info.setTimeout(240_000);
  // Background: "devtool" asked to add "release-bot" to a conversation, a machine "box-9" waits with a code, and an agent asks to connect as "dev-ci"
  const u = await world({ server, page, context, testApi });
  const conv = await createConversation(u.w.owner, { title: "Ship search filters", participants: ["devtool"] });
  must(await asAgent(u.w.srv, u.sessions.devtool!.lease, "POST", `/api/conversations/${conv}/participants`, { handle: "release-bot" }), "request the add", 201);
  await seedUserCodes(u.w.srv, ["PLRT-HXCV"]);
  await requestMachine(u.w.srv, u.w.owner, "box-9");
  must(await mintSession(u.w.srv, u.w.box2.key, { as: "dev-ci", create: { description: "Runs CI" } }), "identity request", 202);
  must(await u.w.owner.client.post(`/api/conversations/${conv}/read`, { main_id: 0, all: true }), "read it all");

  // When the owner opens Now, Then the add card, the machine request and the agent request match their frame
  await page.goto(`${u.w.srv.origin}/`);
  await expect(page.getByRole("article", { name: "box-2 wants to connect as @dev-ci", exact: true })).toBeVisible();
  await expect(page.getByRole("article", { name: /wants to add/ })).toBeVisible();
  await matchesItself(page, info, "now-requests");

  // And when the owner approves the agent, the joined card matches its frame
  await page.getByRole("article", { name: "box-2 wants to connect as @dev-ci", exact: true }).getByRole("button", { name: "Approve", exact: true }).click();
  await expect(page.getByRole("article", { name: "@dev-ci joined", exact: true })).toBeVisible();
  // The card went and the page got shorter; where the scroll lands depends on timing (issue 226). The stored frame is the page at its end: go there and wait until it stays.
  await expect
    .poll(() => page.locator("main").evaluate((e) => ((e.scrollTop = e.scrollHeight), Math.round(e.scrollHeight - e.clientHeight - e.scrollTop))), { intervals: [100], timeout: 10_000 })
    .toBe(0);
  await matchesItself(page, info, "now-joined");
});

scenario("Now with a join request keeps its look", { tag: ["@browser"] }, async ({ server, page, context, testApi }, info) => {
  info.setTimeout(240_000);
  // Background: "lane-search" asked to join "Ship search filters", which it is not in
  const u = await world({ server, page, context, testApi });
  const conv = await createConversation(u.w.owner, { title: "Ship search filters", participants: ["devtool"] });
  must(await agentJoins(u.w.srv, u.sessions["lane-search"]!.lease, conv), "ask to join", 201);
  must(await u.w.owner.client.post(`/api/conversations/${conv}/read`, { main_id: 0, all: true }), "read it all");

  // When the owner opens Now
  await page.goto(`${u.w.srv.origin}/`);
  await expect(page.getByRole("article", { name: /wants to join/ })).toBeVisible();

  // Then the join request card matches its frame
  await matchesItself(page, info, "now-join-request");
});

scenario("Crew keeps its look", { tag: ["@browser"] }, async ({ server, page, context, testApi }, info) => {
  info.setTimeout(240_000);
  // Given every agent is idle
  const u = await frozenWorld({ server, page, context, testApi }, { agents: AGENTS, live: ONLINE_IDLE, disabled: NOT_IDLE });

  // When the owner opens Crew, Then it matches its frame
  await page.goto(`${u.w.srv.origin}/crew`);
  await ready(page, "Crew");
  await expect(page.locator("#crew")).toBeVisible();
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

scenario("Conversation details and their sheets keep their look", { tag: ["@browser"] }, async ({ server, page, context, testApi }, info) => {
  info.setTimeout(240_000);
  // Background: the prototype's agents and conversations
  const u = await world({ server, page, context, testApi });
  const ids = await seedPrototype(u);

  // When the owner opens the details of "Why did the nightly export get slower?"
  await page.goto(`${u.w.srv.origin}/chats/${ids["Why did the nightly export get slower?"]}`);
  await expect(page.getByRole("log", { name: "Messages" }).getByRole("article")).toHaveCount(2);
  await page.getByRole("button", { name: "Show details" }).click();
  const details = page.getByRole("complementary", { name: /^Details for / });
  await expect(details.getByRole("button", { name: "Delete conversation" })).toBeVisible();
  // Then they match their frame, with the plain, the danger and the close buttons
  await matchesItself(page, info, "details");

  // And the delete sheet (a danger and a quiet button) and the rename sheet (a primary and a quiet button) match theirs
  await details.getByRole("button", { name: "Delete conversation" }).click();
  await expect(page.getByRole("dialog", { name: "Delete conversation" })).toBeVisible();
  await matchesItself(page, info, "delete-sheet");
  await page.getByRole("dialog", { name: "Delete conversation" }).getByRole("button", { name: "Cancel" }).click();
  await details.getByRole("button", { name: "Rename" }).click();
  await expect(page.getByRole("dialog", { name: "Rename conversation" })).toBeVisible();
  await matchesItself(page, info, "rename-sheet");
});

scenario("An agent profile and its revoke and rename forms keep their look", { tag: ["@browser"] }, async ({ server, page, context, testApi }, info) => {
  info.setTimeout(240_000);
  // Background: the prototype's agents, with docs and orchardist live too
  const u = await frozenWorld({ server, page, context, testApi }, { agents: AGENTS, live: [...LIVE, "docs", "orchardist"] });

  // When the owner opens the profile of night-watch
  await page.goto(`${u.w.srv.origin}/crew/night-watch`);
  await ready(page, "Agent");
  await expect(page.getByRole("button", { name: "Revoke key" })).toBeVisible();
  // Then it matches its frame: small plain and small danger buttons, a primary link, the session list (the "Created" line is the real day, so it is pinned)
  await pin(page.getByText(/^Created .* last used /), "Created Oct 16, 2026, 6:00 PM · last used just now");
  await matchesItself(page, info, "agent-profile");

  // And the Handoffs tab, which is empty, matches its frame
  await page.getByRole("tab", { name: "Handoffs" }).click();
  await expect(page.getByText("No handoff notes.")).toBeVisible();
  await matchesItself(page, info, "agent-handoffs");

  // And the rename form (a field, a primary and a quiet button) and the revoke confirmation (a danger and a quiet button) match theirs
  await page.getByRole("button", { name: "Change handle" }).click();
  await expect(page.getByRole("group", { name: "Change handle" })).toBeVisible();
  await matchesItself(page, info, "agent-rename");
  await page.getByRole("group", { name: "Change handle" }).getByRole("button", { name: "Cancel" }).click();
  await page.getByRole("button", { name: "Revoke key" }).click();
  await expect(page.getByRole("group", { name: "Revoke key" })).toBeVisible();
  await matchesItself(page, info, "agent-revoke");
});

scenario("Account, passkeys, privacy, machines and trash keep their look", { tag: ["@browser"] }, async ({ server, page, context, testApi }, info) => {
  info.setTimeout(240_000);
  // Background: the prototype's agents and conversations, and "Team updates" in the trash
  const u = await world({ server, page, context, testApi });
  const ids = await seedPrototype(u);
  must(await u.w.owner.client.del(`/api/conversations/${ids["Team updates"]}`), "delete Team updates");
  const at = (path: string) => page.goto(`${u.w.srv.origin}${path}`);

  // When the owner opens Account, then Passkeys, Privacy & security, Delete my data, Machines and the Trash
  await at("/account");
  await ready(page, "Account");
  await matchesItself(page, info, "account");
  await at("/settings/passkeys");
  await ready(page, "Passkeys");
  await expect(page.getByRole("button", { name: "Remove passkey" })).toHaveCount(2);
  // Then each matches its frame (the names carry the real day and a "Last used" line the real time of the sign-in, so they are pinned)
  await pin(page.locator("#passkeys strong"), "Passkey 2026-10-16");
  await pin(page.getByText(/^Last used /), "Last used Oct 16, 2026, 6:00 PM");
  await matchesItself(page, info, "passkeys");
  await at("/settings/privacy");
  await ready(page, "Privacy & security");
  await matchesItself(page, info, "privacy");
  await at("/settings/delete");
  await ready(page, "Delete my data");
  await matchesItself(page, info, "delete-data");
  await at("/crew/machines");
  await ready(page, "Machines");
  await expect(page.getByRole("button", { name: "Edit allow-list" })).toBeVisible();
  await matchesItself(page, info, "machines");
  await at("/trash");
  await ready(page, "Trash");
  await expect(page.getByRole("button", { name: "Restore Team updates" })).toBeVisible();
  await matchesItself(page, info, "trash");
  await page.getByRole("button", { name: "Restore Team updates" }).click();
  await expect(page.getByText("Trash is empty.")).toBeVisible();
  await matchesItself(page, info, "trash-empty");
});

scenario("Settings quiet hours, Advanced and the empty states keep their look", { tag: ["@browser"] }, async ({ server, page, context, testApi }, info) => {
  info.setTimeout(240_000);
  // Background: a world with no conversations
  const u = await world({ server, page, context, testApi });

  // When the owner opens Conversations with nothing in it, and a conversation that does not exist
  await page.goto(`${u.w.srv.origin}/chats`);
  await expect(page.locator("#chats-empty")).toBeVisible();
  // Then each matches its frame (the empty state with its icon, and the not-found state)
  await matchesItself(page, info, "conversations-empty");
  await page.goto(`${u.w.srv.origin}/chats/999999`);
  await ready(page, "Conversation not found");
  await matchesItself(page, info, "not-found");

  // And when Quiet hours go on in Settings, the two time fields join the switches and radios
  await page.goto(`${u.w.srv.origin}/settings`);
  await ready(page, "Settings");
  await page.getByRole("switch", { name: "Quiet hours" }).check();
  await expect(page.getByLabel("From")).toBeVisible();
  await matchesItself(page, info, "settings-quiet-hours");

  // And Advanced matches its frame
  await page.getByRole("button", { name: "Advanced", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Load media automatically" })).toBeVisible();
  await matchesItself(page, info, "settings-advanced");
});

scenario("The composer with a file keeps its look", { tag: ["@browser"] }, async ({ server, page, context, testApi }, info) => {
  info.setTimeout(240_000);
  // Background: the prototype's agents and conversations
  const u = await world({ server, page, context, testApi });
  const ids = await seedPrototype(u);

  // When the owner picks a file in the composer of "Why did the nightly export get slower?"
  await page.goto(`${u.w.srv.origin}/chats/${ids["Why did the nightly export get slower?"]}`);
  await expect(page.getByRole("log", { name: "Messages" }).getByRole("article")).toHaveCount(2);
  await page.locator('input[type="file"]').first().setInputFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("regress") });
  await expect(page.getByRole("button", { name: "Remove notes.txt" })).toBeVisible();
  // Then the composer matches its frame, with the remove button on the file
  await matchesItself(page, info, "composer-with-file");
});

scenario("The recovery page and the recovery codes step keep their look", { tag: ["@browser"] }, async ({ server, page, context }, info) => {
  info.setTimeout(240_000);
  // Background: a server with a bootstrap link, and a virtual passkey in the browser
  const srv = await server({ host: "localhost", adminSocket: true });
  await page.clock.setFixedTime(FROZEN_AT);
  const wa = await webauthn(context, page);
  await wa.add();
  const link = await makeBootstrapLink(srv.adminSocket!);

  // When the browser opens the recovery page, it matches its frame
  await page.goto(`${srv.origin}/recover`);
  await expect(page.getByRole("textbox", { name: "Recovery code" })).toBeVisible();
  await matchesItself(page, info, "recover");

  // And when the owner registers the passkey, the codes step opens (the codes are random, so they are masked)
  await page.goto(`${srv.origin}/bootstrap#${link.token}`);
  await page.getByRole("textbox", { name: "Handle" }).fill("drew");
  await page.getByRole("textbox", { name: "Display name" }).fill("Drew");
  await page.getByRole("button", { name: "Register passkey" }).click();
  await expect(page.getByRole("heading", { name: "Save your recovery codes" })).toBeVisible();
  const codes = { mask: [page.getByRole("list", { name: "Recovery codes" })] };
  // Then it matches its frame, with the box unticked and ticked
  await matchesItself(page, info, "codes-step", codes);
  await page.getByRole("checkbox", { name: "I saved them" }).check();
  await matchesItself(page, info, "codes-step-saved", codes);
});
