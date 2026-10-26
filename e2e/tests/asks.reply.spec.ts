import type { Locator, Page } from "@playwright/test";
import { streamOpen, uiWorld } from "../lib/chat-ui.ts";
import { agentPost, convoz, createConversation, inboxItems, startSession, startWatch } from "../lib/chat.ts";
import { QUESTION, agentAsks, askCard, askOf, askWorld, expectState, markAsk, nowOf, openNow, ownerRepliesIn, snoozeAsk } from "../lib/asks.ts";
import { box } from "../lib/mobile.ts";
import { must } from "../lib/owner.ts";
import { expect, scenario } from "../lib/scenario.ts";
import { replyInThread, threadPane } from "../lib/threads-wp5.ts";
import { browserWorld } from "../lib/wp3.ts";

/*
 * ASK REPLIES AND THE SNOOZE SHEET (owner, conv 1 msg 1006): "Snooze ui is janked on mobile. Replying to a feed item should dismiss it and
 * the agent should have to ask it again". The snooze sheet binds as it did. The reply half was changed by the owner's msgs 1117 and 1131
 * (migration 0039): a reply in an ask's thread keeps the ask open under "You replied", the agent answers in the thread and updates the
 * same ask in place (`convoz ask --update`). The bindings of the rule "A reply to an ask is a question" of specs/features/asks.feature.
 */

const NOTE = "@owner replied in the thread of your ask: answer there, then update the same ask with `convoz ask --update <id> --answers ...` (do not send a new ask).";
const UPDATED = "Merge #415 on its own, now that the tests are in?";
const ANSWERS = "Behind a feature flag. @drew-reviewer owns the area. One PR: the change is atomic. The review bot and QA passed. Details are in the thread above and the checks of the PR.";
const DRAFT_QUESTION = "Send this reply to Alex?";

/** The buttons of a card that sit under the rectangle `r`: "label". */
const buttonsUnder = (card: Locator, r: { x: number; y: number; width: number; height: number }): Promise<string[]> =>
  card.getByRole("button").evaluateAll(
    (els, rect) =>
      els
        .filter((e) => {
          const b = e.getBoundingClientRect();
          return b.width > 0 && b.height > 0 && b.right > rect.x && b.left < rect.x + rect.width && b.bottom > rect.y && b.top < rect.y + rect.height;
        })
        .map((e) => (e.textContent || e.getAttribute("aria-label") || "").trim()),
    r,
  );

scenario("Snoozing on a phone opens a sheet that covers no button", { tag: ["@browser", "@phone"] }, async ({ server, page, context }, info) => {
  info.setTimeout(90_000);
  // Given "devtool" asked "Send this reply to Alex?" with the draft "Sounds good, Thursday works." in answer to "Can we meet Thursday?" from "Alex · Slack DM"
  const w = await browserWorld({ server, page, context }, { agents: ["devtool", "docs"], live: ["devtool"] });
  const conv = await createConversation(w.owner, { title: "Ship search filters", participants: ["devtool", "docs"] });
  const ran = await convoz(w.box, w.sessions.devtool!.sid, [
    "ask", "--json", "--draft", "Sounds good, Thursday works.", "--original", "Can we meet Thursday?", "--original-from", "Alex · Slack DM", String(conv), DRAFT_QUESTION,
  ]);
  expect({ code: ran.code, stderr: ran.stderr }).toEqual({ code: 0, stderr: "" });

  // And the owner opens Now on a phone
  await openNow(page, w.srv);
  const card = askCard(page, DRAFT_QUESTION);
  await expect(card.getByRole("textbox", { name: "Draft" })).toBeVisible();
  const snooze = card.getByRole("group", { name: "Ask actions" }).getByRole("button", { name: "Snooze" });
  const menu = page.getByRole("menu");
  const view = page.viewportSize()!;

  // When the owner taps "Snooze" on the card
  await snooze.click();

  // Then a sheet with "1 hour", "Tomorrow" and "Cancel" opens at the bottom of the screen
  for (const name of ["1 hour", "Tomorrow", "Cancel"]) await expect(menu.getByRole("menuitem", { name })).toBeVisible();
  const sheet = await box(menu);
  expect({ left: Math.round(sheet.x), width: Math.round(sheet.width), bottom: Math.round(sheet.y + sheet.height) }).toEqual({ left: 0, width: view.width, bottom: view.height });

  // And the sheet covers no button of the card
  await expect.poll(async () => buttonsUnder(card, await box(menu))).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

  // And the sheet is shown in dark and in light
  for (const scheme of ["dark", "light"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await expect(menu).toBeVisible();
    await page.screenshot({ path: `/tmp/askreply-snooze-sheet-${scheme}.png` });
  }

  // When the owner taps outside the sheet
  await page.touchscreen.tap(view.width / 2, 24);

  // Then the sheet closes
  await expect(menu).toHaveCount(0);

  // When the owner taps "Snooze" and then "Cancel"
  await snooze.click();
  await menu.getByRole("menuitem", { name: "Cancel" }).click();

  // Then the sheet closes and the ask is still in Now
  await expect(menu).toHaveCount(0);
  await expect(card).toBeVisible();

  // When the owner taps "Snooze" and then "1 hour"
  await snooze.click();
  await menu.getByRole("menuitem", { name: "1 hour" }).click();

  // Then the sheet closes and Now no longer lists the ask
  await expect(menu).toHaveCount(0);
  await expect(card).toHaveCount(0);
});

scenario("Replying to an ask keeps it open and moves it to You replied", { tag: ["@browser"] }, async ({ server, page, context }, info) => {
  info.setTimeout(90_000);
  // Given an open ask of "devtool", and the owner has the conversation and Now open in two pages
  const u = await uiWorld({ server, page, context }, { agents: ["devtool"], live: ["devtool"] });
  const lease = u.sessions.devtool!.lease;
  const conv = await createConversation(u.w.owner, { title: "Ship search filters", participants: ["devtool"] });
  const id = await agentAsks(u.w.srv, lease, conv);
  await page.goto(`${u.w.srv.origin}/chats/${conv}`);
  await expect(askCard(page).getByRole("button", { name: "Quick reply" })).toBeVisible();
  const now: Page = await context.newPage();
  await openNow(now, u.w.srv);
  await expect(askCard(now)).toBeVisible();
  await streamOpen(page);
  await streamOpen(now);

  // When the owner replies to the ask in its thread
  await askCard(page).getByRole("button", { name: "I have questions" }).click();
  await threadPane(page).waitFor();
  await replyInThread(page, "Use the smaller one");

  // Then Now no longer lists it in the main list but under "You replied · waiting on the agent", with no reload
  await expect(askCard(now)).toHaveCount(0, { timeout: 4_000 });
  const replied = now.locator("#replied");
  await expect(replied.getByText("You replied · waiting on the agent", { exact: true })).toBeVisible({ timeout: 4_000 });
  await expect(replied.getByRole("link", { name: new RegExp(QUESTION) })).toContainText("Use the smaller one");
  expect((await nowOf(u.w.owner)).badge).toBe(0);
  expect(await expectState(u.w.owner, id)).toBe("open");

  // And the card in the conversation shows "You replied · waiting on @devtool" and still offers its options
  const card = askCard(page).first();
  await expect(card).toContainText("You replied · waiting on @devtool", { timeout: 4_000 });
  await expect(card.getByRole("button", { name: "Quick reply" })).toBeVisible();
  await expect(card.getByRole("button", { name: "Merge it" })).toBeVisible();
});

scenario("An ask inside a thread has Quick reply too", { tag: ["@browser"] }, async ({ server, page, context }, info) => {
  info.setTimeout(90_000);
  // Given "devtool" asks inside the thread of its message "Step 1 is the chips UI"
  const u = await uiWorld({ server, page, context }, { agents: ["devtool"], live: ["devtool"] });
  const lease = u.sessions.devtool!.lease;
  const conv = await createConversation(u.w.owner, { title: "Ship search filters", participants: ["devtool"] });
  const root = must(await agentPost(u.w.srv, lease, conv, "Step 1 is the chips UI"), "the root", 201).json().id as number;
  await agentAsks(u.w.srv, lease, conv, { thread: root });

  // When the owner opens the conversation
  await page.goto(`${u.w.srv.origin}/chats/${conv}`);

  // Then the ask card in the thread offers "Quick reply" and "I have questions"
  const card = askCard(page).first();
  await expect(card.getByRole("button", { name: "Quick reply" })).toBeVisible();
  await expect(card.getByRole("button", { name: "I have questions" })).toBeVisible();

  // When the owner sends the quick reply "Use the smaller one"
  await card.getByRole("button", { name: "Quick reply" }).click();
  await card.getByRole("textbox", { name: "Quick reply" }).fill("Use the smaller one");
  await card.getByRole("button", { name: "Send", exact: true }).click();

  // Then the ask shows "Replied · Use the smaller one"
  await expect(page.getByText("Replied · Use the smaller one")).toBeVisible();
});

scenario("An agent's reply does not close an ask", { tag: ["@cli"] }, async ({ server }) => {
  // Given an open ask of "devtool"
  const { w, conv, devtool, docs } = await askWorld(server);
  const id = await agentAsks(w.srv, devtool.lease, conv);

  // When "docs" replies in the thread of the ask
  must(await agentPost(w.srv, docs.lease, conv, "Any thoughts?", { thread_root_id: id }), "docs replies in the thread of the ask", 201);

  // And "devtool" replies in the thread of the ask
  must(await agentPost(w.srv, devtool.lease, conv, "Still waiting", { thread_root_id: id }), "devtool replies in the thread of the ask", 201);

  // Then the ask is still open
  expect(await expectState(w.owner, id)).toBe("open");
  expect((await askOf(w.owner, id)).owner_reply).toBeUndefined();
});

scenario("An agent is told to answer in the thread and send the updated ask there", { tag: ["@cli"] }, async ({ server }) => {
  // Given an open ask of "devtool" that the owner then snoozed
  const { w, conv, devtool } = await askWorld(server);
  const id = await agentAsks(w.srv, devtool.lease, conv);
  must(await snoozeAsk(w.owner, id, { preset: "1h" }), "snooze");

  // When the owner replies in the thread of the ask
  const reply = await ownerRepliesIn(w.owner, conv, id, "Use the smaller one, but why not both?");

  // Then the ask is still open and records the reply and its message
  const ask = await askOf(w.owner, id);
  expect({ state: ask.state, reply: ask.owner_reply?.id, text: ask.owner_reply?.text, snoozed: Boolean(ask.snoozed_until) }).toEqual({
    state: "open", reply, text: "Use the smaller one, but why not both?", snoozed: true,
  });

  // And the history of the ask has an "owner_replied" row
  expect(ask.history?.map((h) => `${h.event}:${h.to_state}`)).toEqual(["create:open", "owner_replied:open"]);

  // And "devtool" reads in its inbox and in its watch: "@owner replied in the thread of your ask: answer there, then update the same ask with `convoz ask --update <id> --answers ...` (do not send a new ask)."
  const item = (await inboxItems(w.box, devtool.sid, ["--peek"])).find((i) => i.reason === "ask_resolved") as unknown as { message: { id: number; ask: { state: string } } };
  expect({ ask: item.message.id, state: item.message.ask.state }).toEqual({ ask: id, state: "open" });
  const peek = await convoz(w.box, devtool.sid, ["inbox", "--peek"]);
  expect(peek.stdout).toContain(NOTE);
  const watch = startWatch(w.box, devtool.sid);
  try {
    await watch.waitForStdout(/ask_resolved/, 10_000);
    const lines = watch.stdout().split("\n").filter(Boolean).map((l) => JSON.parse(l) as { reason: string; note?: string });
    expect(lines.find((l) => l.reason === "ask_resolved")?.note).toBe(NOTE);
  } finally {
    await watch.stop();
  }
});

/** `convoz ask --update ID` as an agent. The raw run. */
const updateAsk = (w: { box: Parameters<typeof convoz>[0] }, sid: string, id: number, extra: string[]) => convoz(w.box, sid, ["ask", "--json", "--update", String(id), ...extra]);
const NEW_OPTIONS = ["--recommend", "Merge it", "--why", "Behind a flag, bot and QA passed", "--alt", "Hold it", "--alt-why", "Wait for #412"];

scenario("The agent updates the ask in place with the answers", { tag: ["@cli"] }, async ({ server }) => {
  // Given an open ask of "devtool" that the owner replied to
  const { w, conv, devtool } = await askWorld(server);
  const id = await agentAsks(w.srv, devtool.lease, conv);
  await ownerRepliesIn(w.owner, conv, id, "Which checks pass?");
  const before = await askOf(w.owner, id);

  // When "devtool" runs "convoz ask --update" with a new question, new options and a summary of its answers
  const ran = await updateAsk(w, devtool.sid, id, ["--question", UPDATED, ...NEW_OPTIONS, "--answers", ANSWERS]);
  expect({ code: ran.code, stderr: ran.stderr }).toEqual({ code: 0, stderr: "" });

  // Then it is the same ask, still open, with the new question and options, the summary, the version moved and an "updated" row in its history
  const ask = await askOf(w.owner, id);
  expect({ id: ask.id, state: ask.state, question: ask.question, options: ask.options.map((o) => o.why), answers: ask.answers, revision: ask.revision, changed: ask.changed }).toEqual({
    id, state: "open", question: UPDATED, options: ["Behind a flag, bot and QA passed", "Wait for #412"], answers: ANSWERS, revision: 2, changed: "question, options",
  });
  expect(ask.version).toBeGreaterThan(before.version);
  expect(ask.history?.map((h) => h.event)).toEqual(["create", "owner_replied", "updated"]);

  // And the owner's reply mark is gone and the ask is in the main list of Now, not under "You replied"
  expect(ask.owner_reply).toBeUndefined();
  const now = await nowOf(w.owner);
  expect({ main: now.asks.map((a) => a.id), replied: now.replied }).toEqual({ main: [id], replied: [] });

  // And no new ask was made and "devtool" has the same number of open asks
  expect((await convoz(w.box, devtool.sid, ["brief"])).stdout).toContain(UPDATED);
  expect(now.asks).toHaveLength(1);
});

scenario("An update needs the answers, the asker and an open ask", { tag: ["@cli"] }, async ({ server }) => {
  // Given an open ask of "devtool" that the owner replied to
  const { w, conv, devtool, docs } = await askWorld(server);
  const id = await agentAsks(w.srv, devtool.lease, conv);
  await ownerRepliesIn(w.owner, conv, id, "Which checks pass?");

  // When "devtool" updates it without answers
  const bare = await updateAsk(w, devtool.sid, id, ["--question", UPDATED]);

  // Then the update is refused and names the field "answers"
  expect(bare.code).not.toBe(0);
  expect(bare.stdout + bare.stderr).toContain("answers");

  // When "docs" updates it
  const other = await updateAsk(w, docs.sid, id, ["--question", UPDATED, "--answers", ANSWERS]);

  // Then the update is refused
  expect(other.code).not.toBe(0);
  expect((await askOf(w.owner, id)).question).toBe(QUESTION);

  // When the owner dismisses the ask and "devtool" updates it
  must(await markAsk(w.owner, id, "dismiss"), "dismiss");
  const late = await updateAsk(w, devtool.sid, id, ["--question", UPDATED, "--answers", ANSWERS]);

  // Then the update is refused as a conflict
  expect(late.code).not.toBe(0);
  expect((await askOf(w.owner, id)).question).toBe(QUESTION);
});

scenario("The rules tell an agent to pre-answer the owner's obvious questions", { tag: ["@cli"] }, async ({ server }) => {
  const { w } = await askWorld(server);
  // When an agent reads "convoz rules"
  const rules = (await w.box.run(["rules", "--as", "devtool"])).stdout;

  // Then the rules say to answer the owner's obvious questions in the ask and name feature flag, reviewer, number of PRs, review bot and QA
  expect(rules).toContain("Before an ask, answer the owner's obvious questions in it.");
  for (const word of ["feature flag", "why this reviewer", "why N PRs and not one", "review bot and QA"]) expect(rules).toContain(word);

  // And the rules say to answer questions asked in the ask's thread and update the same ask with "convoz ask --update"
  expect(rules).toContain("answer them there and update the same ask (`convoz ask --update`)");
});

scenario("The updated ask shows in Now with the answers, and leaves You replied", { tag: ["@browser"] }, async ({ server, page, context }, info) => {
  info.setTimeout(90_000);
  // Given an open ask of "devtool" that the owner replied to, and the owner has the conversation and Now open in two pages
  const u = await uiWorld({ server, page, context }, { agents: ["devtool"], live: ["devtool"] });
  const lease = u.sessions.devtool!.lease;
  const conv = await createConversation(u.w.owner, { title: "Ship search filters", participants: ["devtool"] });
  const id = await agentAsks(u.w.srv, lease, conv);
  await ownerRepliesIn(u.w.owner, conv, id, "Which checks pass?");
  await page.goto(`${u.w.srv.origin}/chats/${conv}`);
  await expect(askCard(page, QUESTION).first()).toContainText("You replied · waiting on @devtool");
  const now: Page = await context.newPage();
  await openNow(now, u.w.srv);
  await expect(now.locator("#replied")).toBeVisible();
  await streamOpen(page);
  await streamOpen(now);

  // When "devtool" updates the ask with its answers
  const ran = await convoz(u.w.box, u.sessions.devtool!.sid, ["ask", "--json", "--update", String(id), "--question", UPDATED, "--answers", ANSWERS]);
  expect({ code: ran.code, stderr: ran.stderr }).toEqual({ code: 0, stderr: "" });

  // Then Now lists the ask in the main list with "Your questions, answered" and the answers in full, with no "More" to tap on a wide screen
  // (owner, msg 2064: quick to read); a phone folds an answer at 3 lines so the options stay on screen (conv 179 msg 4342), and "More" shows the rest
  const card = askCard(now, UPDATED);
  await expect(card).toContainText("Your questions, answered", { timeout: 4_000 });
  const more = card.getByRole("button", { name: "More" });
  if (now.viewportSize()!.width > 600) await expect(more).toHaveCount(0);
  else if (await more.count()) await more.click();
  await expect(card.locator("[data-a]")).toHaveText(ANSWERS);
  await expect(card.getByRole("button", { name: "More" })).toHaveCount(0);

  // And the ask is no longer under "You replied"
  await expect(now.locator("#replied")).toHaveCount(0);
  await expect(askCard(now, QUESTION)).toHaveCount(0);

  // And the card in the conversation shows the same, and its history has the update
  const inline = askCard(page, UPDATED).first();
  await expect(inline).toContainText("Your questions, answered", { timeout: 4_000 });
  await inline.getByRole("button", { name: "Ask options" }).click();
  await page.getByRole("menuitem", { name: "History" }).click();
  await expect(inline.getByRole("list", { name: "History" })).toContainText("Updated by Devtool @devtool");
});

scenario("An ask in Now with replies opens its thread in place and folds it again", { tag: ["@browser"] }, async ({ server, page, context }) => {
  // Given an open ask of "devtool" with the reply "Both fit; the smaller one is safer." from "docs" in its thread
  const u = await uiWorld({ server, page, context }, { agents: ["devtool", "docs"], live: ["devtool"] });
  const conv = await createConversation(u.w.owner, { title: "Ship search filters", participants: ["devtool", "docs"] });
  const id = await agentAsks(u.w.srv, u.sessions.devtool!.lease, conv);
  const docs = await startSession(u.w.box, "docs", "docs");
  const reply = "Both fit; the smaller one is safer.";
  must(await agentPost(u.w.srv, docs.lease, conv, reply, { thread_root_id: id }), "docs replies in the thread of the ask", 201);

  // When the owner opens Now
  await openNow(page, u.w.srv);
  // the feed item: the card and what hangs under it
  const card = page.locator("[data-conv]").filter({ has: askCard(page) });

  // Then the ask card offers "Show thread" with 1 reply
  const toggle = card.getByRole("button", { name: /Show thread/ });
  await expect(toggle).toContainText("1");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");

  // When the owner opens the thread of the card
  await toggle.click();

  // Then the card shows the reply and the page is still Now
  await expect(card.getByText(reply)).toBeVisible();
  await expect(card.getByRole("button", { name: /Hide thread/ })).toHaveAttribute("aria-expanded", "true");
  expect(new URL(page.url()).pathname).toMatch(/^\/now|^\/$/);

  // When the owner folds the thread of the card
  await card.getByRole("button", { name: /Hide thread/ }).click();

  // Then the reply is no longer shown
  await expect(card.getByText(reply)).toHaveCount(0);
});
