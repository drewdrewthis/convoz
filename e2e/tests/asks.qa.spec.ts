import type { Locator, Page } from "@playwright/test";
import { uiWorld } from "../lib/chat-ui.ts";
import { convoz, createConversation } from "../lib/chat.ts";
import { QUESTION, agentAsks, askCard, openNow, ownerRepliesIn } from "../lib/asks.ts";
import { box } from "../lib/mobile.ts";
import { expect, scenario } from "../lib/scenario.ts";

/*
 * THE Q&A SECTION OF AN UPDATED ASK (Drew, conv 179 msg 4342; spec /tmp/convoz-ux/qa-feeditem.md): the question is the brightest text,
 * the answers are their own section under it ("Your questions, answered", an accent edge), each question over its answer, links short,
 * the version in History, and a long answer folds so the options stay on the first screen. The bindings of the rule "An updated ask
 * shows the owner's questions and the agent's answers as their own section under the question" of specs/features/asks.feature.
 * The answers are seeded the way an agent sends them: the owner replies in the ask's thread, then "convoz ask --update <id> --answers".
 */

const QA = "Q: It was deployed? A: Yes. The block was lifted.";
const PLAIN = "Behind a feature flag.\nThe review bot and QA passed, and @drew-reviewer owns the area.";
const NEVER = "Ship the docs today?";
const RUN = "https://github.com/langwatch/langwatch-saas/actions/runs/39923502587";
const PR = "https://github.com/langwatch/langwatch-saas/pull/1382";
const PAGE = "https://example.com/docs/deploy-block/rule-2";
const LINKS = `A: Rogerio ran the prod apply ${RUN} after Alex merged ${PR} (see ${PAGE}).`;
const LONG_BODY = "The block was lifted, not bypassed: Alex merged the network change and Rogerio ran the prod apply. ".repeat(12).slice(0, 885).trim();
const LONG = `Q: Why now? A: ${LONG_BODY}`;
const SECTION = /^Your questions, answered/;

type Fx = Parameters<typeof uiWorld>[0];

/** An open ask of "devtool" that the owner replied to in its thread and "devtool" then updated with `answers`. */
async function updatedAsk(fx: Fx, answers: string) {
  const u = await uiWorld(fx, { agents: ["devtool"], live: ["devtool"] });
  const conv = await createConversation(u.w.owner, { title: "Ship search filters", participants: ["devtool"] });
  const id = await agentAsks(u.w.srv, u.sessions.devtool!.lease, conv);
  await ownerRepliesIn(u.w.owner, conv, id, "It was deployed?");
  const ran = await convoz(u.w.box, u.sessions.devtool!.sid, ["ask", "--json", "--update", String(id), "--answers", answers]);
  expect({ code: ran.code, stderr: ran.stderr }).toEqual({ code: 0, stderr: "" });
  return { u, conv, id };
}

/** The computed colour of a token ("--color-text") on this page, to compare with an element's computed colour. */
const token = (page: Page, name: string): Promise<string> =>
  page.evaluate((t) => {
    const probe = document.createElement("span");
    probe.style.color = `var(${t})`;
    document.body.append(probe);
    const c = getComputedStyle(probe).color;
    probe.remove();
    return c;
  }, name);

const color = (l: Locator): Promise<string> => l.evaluate((e) => getComputedStyle(e).color);
const section = (card: Locator): Locator => card.getByRole("group", { name: SECTION });

/** AC 1 to 3 on one card: a bright question, the section under it with its edge, and the question and the answer as two rows. */
async function expectQaSection(page: Page, card: Locator): Promise<void> {
  const heading = card.getByRole("heading", { name: QUESTION });
  const qa = section(card);
  await expect(qa).toBeVisible({ timeout: 4_000 });
  expect(await color(heading)).toBe(await token(page, "--color-text"));

  const h = await box(heading);
  const s = await box(qa);
  expect(s.y - (h.y + h.height)).toBeGreaterThanOrEqual(8);
  const edge = await qa.evaluate((e) => {
    const st = getComputedStyle(e);
    return { width: st.borderLeftWidth, style: st.borderLeftStyle, color: st.borderLeftColor };
  });
  expect(edge).toEqual({ width: "2px", style: "solid", color: await token(page, "--color-accent") });

  const q = qa.locator("[data-q]");
  const a = qa.locator("[data-a]");
  await expect(q).toHaveCount(1);
  await expect(a).toHaveCount(1);
  await expect(q).toHaveText("It was deployed?");
  await expect(a).toHaveText("Yes. The block was lifted.");
  expect(await color(q)).toBe(await token(page, "--color-muted"));
  expect(await color(a)).toBe(await token(page, "--color-text"));
  await expect(qa).not.toContainText("Q:");
  await expect(qa).not.toContainText("A:");
}

scenario("An updated ask shows each question and its answer in a section under a bright question", { tag: ["@browser"] }, async ({ server, page, context }, info) => {
  info.setTimeout(90_000);
  // Given an open ask of "devtool" that the owner replied to with "It was deployed?"
  // When "devtool" updates the ask with the answers "Q: It was deployed? A: Yes. The block was lifted."
  const { u, conv } = await updatedAsk({ server, page, context }, QA);

  // Then the card in Now and the card in the conversation show the question in the text color, not the muted one
  // And under it, 8 px or more below and with an accent edge on its left, a section "Your questions, answered"
  // And the section shows "It was deployed?" muted and "Yes. The block was lifted." in the text color, as two rows with no "Q:" and no "A:"
  await openNow(page, u.w.srv);
  await expectQaSection(page, askCard(page));
  await page.goto(`${u.w.srv.origin}/chats/${conv}`);
  await expectQaSection(page, askCard(page).first());
  await expect(askCard(page).first()).toBeVisible();
});

scenario("Answers with no Q and A marks show in full, and an ask never updated shows no section", { tag: ["@browser"] }, async ({ server, page, context }, info) => {
  info.setTimeout(90_000);
  // Given an open ask of "devtool" updated with answers that carry no "Q:" and no "A:"
  const { u, conv } = await updatedAsk({ server, page, context }, PLAIN);
  // And an open ask of "devtool" that was never updated
  await agentAsks(u.w.srv, u.sessions.devtool!.lease, conv, { question: NEVER });

  // When the owner opens Now
  await openNow(page, u.w.srv);

  // Then the updated card shows the whole text as one answer, the same text as the agent sent
  const qa = section(askCard(page));
  await expect(qa).toBeVisible({ timeout: 4_000 });
  await expect(qa.locator("[data-a]")).toHaveCount(1);
  expect(await qa.locator("[data-a]").evaluate((e) => e.textContent)).toBe(PLAIN);

  // And the card never updated has no section "Your questions, answered" and its question keeps its muted color
  const never = askCard(page, NEVER);
  await expect(never).toBeVisible();
  await expect(section(never)).toHaveCount(0);
  await expect(never).not.toContainText("Your questions, answered");
  expect(await color(never.getByRole("heading", { name: NEVER }))).toBe(await token(page, "--color-muted"));
});

scenario("The version of an update is in History, not on the card", { tag: ["@browser"] }, async ({ server, page, context }, info) => {
  info.setTimeout(90_000);
  // Given an open ask of "devtool" that the owner replied to and "devtool" updated with its answers
  const { u, conv } = await updatedAsk({ server, page, context }, QA);

  // When the owner opens Now and the conversation
  // Then neither card shows "v2" or "changed:"
  await openNow(page, u.w.srv);
  const card = askCard(page);
  await expect(section(card)).toBeVisible({ timeout: 4_000 });
  await expect(card).not.toContainText("v2");
  await expect(card).not.toContainText("changed:");
  await page.goto(`${u.w.srv.origin}/chats/${conv}`);
  const inline = askCard(page).first();
  await expect(section(inline)).toBeVisible({ timeout: 4_000 });
  await expect(inline).not.toContainText("v2");
  await expect(inline).not.toContainText("changed:");

  // And the History of the card in the conversation shows "Updated by Devtool @devtool · v2, changed answers"
  await inline.getByRole("button", { name: "Ask options" }).click();
  await page.getByRole("menuitem", { name: "History" }).click();
  await expect(inline.getByRole("list", { name: "History" })).toContainText("Updated by Devtool @devtool · v2, changed answers");
});

scenario("A link in an answer is a short link to the full address", { tag: ["@browser"] }, async ({ server, page, context }, info) => {
  info.setTimeout(90_000);
  // Given an open ask of "devtool" updated with an answer that names a run, a PR and a page by their full addresses
  const { u } = await updatedAsk({ server, page, context }, LINKS);

  // When the owner opens Now
  await openNow(page, u.w.srv);
  const qa = section(askCard(page));
  await expect(qa).toBeVisible({ timeout: 4_000 });

  // Then the answer shows the links "run 39923502587", "PR 1382" and "example.com", each to its full address and on one line
  for (const [name, href] of [["run 39923502587", RUN], ["PR 1382", PR], ["example.com", PAGE]] as const) {
    const link = qa.getByRole("link", { name, exact: true });
    await expect(link).toHaveAttribute("href", href);
    expect(name.length).toBeLessThan(href.length);
    expect(await link.evaluate((e) => e.getClientRects().length)).toBe(1);
  }

  // And no full address shows as text
  await expect(qa).not.toContainText("https://");
});

scenario("On a phone a long answer folds so the first option stays on the first screen of the card", { tag: ["@browser", "@phone"] }, async ({ server, page, context }, info) => {
  info.setTimeout(90_000);
  // Given an open ask of "devtool" updated with an answer of 900 characters
  expect(LONG.length).toBeGreaterThanOrEqual(890);
  const { u } = await updatedAsk({ server, page, context }, LONG);

  // When the owner opens Now on a phone (390 x 844)
  expect(page.viewportSize()).toEqual({ width: 390, height: 844 });
  await openNow(page, u.w.srv);
  const card = askCard(page);
  const qa = section(card);
  const answer = qa.locator("[data-a]");
  await expect(qa).toBeVisible({ timeout: 4_000 });

  // Then the answer is folded to 3 lines and the first option is inside the screen when the top of the card is at the top of the screen
  const lines = async () => (await box(answer)).height / 20;
  expect(await lines()).toBeLessThanOrEqual(3.05);
  const top = (await box(card)).y;
  const option = await box(card.getByRole("button", { name: "Merge it", exact: true }));
  expect(option.y + option.height - top).toBeLessThanOrEqual(844);

  // When the owner taps "More"
  await qa.getByRole("button", { name: "More" }).click();

  // Then the full answer shows
  await expect(answer).toHaveText(LONG_BODY);
  await expect.poll(lines).toBeGreaterThan(6);

  // When the owner taps "Less"
  await qa.getByRole("button", { name: "Less" }).click();

  // Then the answer folds to 3 lines again
  await expect.poll(lines).toBeLessThanOrEqual(3.05);
});
