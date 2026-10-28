import type { Locator, Page, TestInfo } from "@playwright/test";
import { createConversation } from "../lib/chat.ts";
import { mainNav } from "../lib/chat-ui.ts";
import { overflowX } from "../lib/mobile.ts";
import { detailsPanel, mustPlan, planUi, type PlanWorld } from "../lib/plan.ts";
import { must } from "../lib/owner.ts";
import { expect, scenario } from "../lib/scenario.ts";

/*
 * WORK (delivery.feature, Rule "Work shows every plan ..."). Owner (Drew, conv 179): one screen, in a hierarchy, of what needs him, what is
 * blocked, what is in work and what is planned, current without a button. Page contract (/work; /delivery opens it):
 *   #work holds the line "Live · Convoz asks agents when a plan is late", then one region per non-empty section, named by its label, with an
 *   h2 "<label> · N", in this order: Needs you, Blocked or late, In progress, Planned. Each row is a link to /chats/<conv>#plan-<handle> that
 *   holds the chat title, "@agent", the row's text (the Waiting item, "Blocked: …", "Late: …", the Now item or the first Next), and for a plan
 *   in work its step (role img "Step N of M"), a due chip "Due …" and "updated … ago". No row has a button. Stale chats are hidden from In
 *   progress and Planned behind "N stale chat(s) hidden" and a "Show" button. "Done today · N" is a chip that opens what was done today.
 *   The details panel's agent card (#plan-<handle>) shows "Waiting on you: …" and "Delivers: … · due …".
 */

const MIN = 60_000;

const work = (page: Page): Locator => page.locator("#work");
const section = (page: Page, label: string): Locator => work(page).getByRole("region", { name: label, exact: true });
const rowIn = (sec: Locator, title: string): Locator => sec.getByRole("link").filter({ hasText: title });

/** The owner opens Work as a person would: from the rail on a computer, from the bottom bar on a phone. */
async function openWork(page: Page, p: PlanWorld, info: TestInfo): Promise<void> {
  await page.goto(`${p.w.srv.origin}/`);
  const link = info.project.name === "mobile" ? mainNav(page).getByRole("link", { name: "Work" }) : page.getByRole("navigation", { name: "Conversations" }).getByRole("link", { name: /^Work/ });
  await link.click();
  await expect(page.getByRole("heading", { name: "Work", exact: true })).toBeVisible();
}

async function shoot(page: Page, info: TestInfo, name: string): Promise<void> {
  await page.screenshot({ path: info.outputPath(`${name}-${info.project.name}.png`), fullPage: true });
}

/** SHOTS is where CI keeps the Work screenshots on every run, pass or fail (artifact "work-shots-<shard>"), as the PR's use-proof. */
const SHOTS = "/tmp/convoz-e2e-shots";
const proof = (page: Page, info: TestInfo): Promise<Buffer> =>
  page.screenshot({ path: `${SHOTS}/work-${info.project.name === "mobile" ? "phone" : "desktop"}.png`, fullPage: true });

scenario("Work puts each plan in the highest section that applies", { tag: ["@browser"] }, async ({ server, page, context, testApi }, info) => {
  info.setTimeout(120_000);
  const p = await planUi({ server, page, context }, { docsIn: false });
  const titled = (title: string, who = "devtool") => createConversation(p.w.owner, { title, participants: [who] });
  const close = async (conv: number) => must(await p.w.owner.client.post(`/api/conversations/${conv}/stale`, { force: true }), "close the conversation");
  // Given "devtool" is doing "Filter chips" at step 2 of 5, ready in 2 hours, and delivers "Search filters live" in 3 days
  await mustPlan(p, p.dev, ["--doing", "Filter chips", "--step", "2/5", "--eta", "2h", "--deliver", "Search filters live", "--due", "3d"]);
  // And "docs" is doing "Docs pass" in conversation 42 and waits on the owner for "Approve the docs copy"
  await mustPlan(p, p.docs, ["--doing", "Docs pass", "--waiting", "Approve the docs copy"], await titled("Docs refresh", "docs"));
  // And "devtool" is doing "Deploy preview" in conversation 43 "Blocked one" and is blocked on "CI is down"
  await mustPlan(p, p.dev, ["--doing", "Deploy preview", "--blocked", "CI is down"], await titled("Blocked one"));
  // And "devtool" delivers "Release notes" in 30 minutes in conversation 44 "Late one"
  await mustPlan(p, p.dev, ["--deliver", "Release notes", "--due", "30m"], await titled("Late one"));
  // And "devtool" has only "Write the changelog" next in conversation 45 "Next only"
  await mustPlan(p, p.dev, ["--next", "Write the changelog"], await titled("Next only"));
  // And "devtool" is doing "Closed work" in conversation 46 "Closed one", which the owner closed
  const closed = await titled("Closed one");
  await mustPlan(p, p.dev, ["--doing", "Closed work"], closed);
  await close(closed);
  // And "devtool" waits on the owner for "Pick a name" in conversation 47 "Old ask", which the owner closed
  const oldAsk = await titled("Old ask");
  await mustPlan(p, p.dev, ["--waiting", "Pick a name"], oldAsk);
  await close(oldAsk);
  // And "devtool" finished "Old work" in conversation 48 "Wrapped up"
  await mustPlan(p, p.dev, ["--done", "Old work"], await titled("Wrapped up"));

  // When 31 minutes pass
  await testApi(p.w.srv).advanceClock(31 * MIN);
  // And the owner opens Work from the rail on a computer, or from the bottom bar on a phone
  await openWork(page, p, info);

  // Then the page reads "Live · Convoz asks agents when a plan is late" at the top
  await expect(work(page).locator("p").first()).toHaveText("Live · Convoz asks agents when a plan is late");
  // And the sections read "Needs you · 2", "Blocked or late · 2", "In progress · 1" and "Planned · 1", in that order
  await expect(work(page).locator("h2")).toHaveText(["Needs you · 2", "Blocked or late · 2", "In progress · 1", "Planned · 1"]);

  // And "Needs you" holds "Docs refresh" with "@docs" and "Approve the docs copy", and "Old ask" with "Pick a name"
  const needs = section(page, "Needs you");
  await expect(rowIn(needs, "Docs refresh")).toContainText("@docs");
  await expect(rowIn(needs, "Docs refresh")).toContainText("Approve the docs copy");
  await expect(rowIn(needs, "Old ask")).toContainText("Pick a name");
  // And "Blocked or late" holds "Blocked one" with "Blocked: CI is down" and "Late one" with "Late: Release notes"
  const blocked = section(page, "Blocked or late");
  await expect(rowIn(blocked, "Blocked one")).toContainText("Blocked: CI is down");
  await expect(rowIn(blocked, "Late one")).toContainText("Late: Release notes");
  // And "In progress" holds "Ship search filters" with "@devtool", "Filter chips", "Step 2 of 5", a due chip and "updated 31 min ago"
  const doing = rowIn(section(page, "In progress"), "Ship search filters");
  await expect(doing).toContainText("@devtool");
  await expect(doing).toContainText("Filter chips");
  await expect(doing.getByRole("img", { name: "Step 2 of 5" })).toBeVisible();
  await expect(doing).toContainText(/Due \S/);
  await expect(doing).toContainText("updated 31 min ago");
  // And "Planned" holds "Next only" with "Write the changelog"
  await expect(rowIn(section(page, "Planned"), "Next only")).toContainText("Write the changelog");
  // And no row has "Request update"
  await expect(work(page).getByRole("button", { name: "Request update" })).toHaveCount(0);
  // And no row comes from "Closed one", and the page says "1 stale chat hidden · Show"
  await expect(work(page)).not.toContainText("Closed one");
  await expect(work(page)).toContainText("1 stale chat hidden");
  // And on a phone the page does not scroll sideways and each row is two lines
  if (info.project.name === "mobile") {
    expect(await overflowX(page)).toBe(0);
    for (const box of await Promise.all((await work(page).getByRole("link").all()).map((l) => l.boundingBox()))) expect(box!.height).toBeLessThanOrEqual(76);
  }
  await shoot(page, info, "work");
  await proof(page, info);

  // When the owner taps "Show"
  await work(page).getByRole("button", { name: "Show", exact: true }).click();
  // Then "In progress" holds "Closed one"
  await expect(rowIn(section(page, "In progress"), "Closed one")).toContainText("Closed work");

  // When the owner opens "Done today · 1"
  await work(page).getByRole("button", { name: "Done today · 1" }).click();
  // Then it lists "Old work" by "@devtool"
  await expect(section(page, "Done today")).toContainText("Old work");
  await expect(section(page, "Done today")).toContainText("@devtool");
});

scenario("A Work row opens its chat on that agent's plan, with what it waits on and delivers", { tag: ["@browser"] }, async ({ server, page, context }, info) => {
  info.setTimeout(60_000);
  const p = await planUi({ server, page, context }, { docsIn: false });
  // Given "devtool" is doing "Filter chips" in conversation 41, waits on the owner for "Approve the copy" and delivers "Search filters live" in 3 days
  await mustPlan(p, p.dev, ["--doing", "Filter chips", "--waiting", "Approve the copy", "--deliver", "Search filters live", "--due", "3d"]);

  // When the owner opens Work and taps the row "Ship search filters"
  await openWork(page, p, info);
  await rowIn(section(page, "Needs you"), "Ship search filters").click();

  // Then conversation 41 opens with the details on the plan card of "@devtool"
  await expect(page).toHaveURL(new RegExp(`/chats/${p.conv}#plan-devtool$`));
  const card = detailsPanel(page).locator("#plan-devtool");
  await expect(card).toBeVisible();
  // And the card shows "Waiting on you: Approve the copy" and "Delivers: Search filters live" with its due date
  await expect(card).toContainText("Waiting on you: Approve the copy");
  await expect(card).toContainText(/Delivers: Search filters live · due \S/);
  await shoot(page, info, "work-opens-plan");
});

scenario("With no plans Work says how they come, and an old Deliveries link opens Work", { tag: ["@browser"] }, async ({ server, page, context }) => {
  const p = await planUi({ server, page, context }, { docsIn: false });
  // When the owner opens /delivery
  await page.goto(`${p.w.srv.origin}/delivery`);
  // Then the address is /work and the page is "Work"
  await expect(page).toHaveURL(/\/work$/);
  await expect(page.getByRole("heading", { name: "Work", exact: true })).toBeVisible();
  // And the page says "Nothing in progress. When an agent sets a plan, it shows here."
  await expect(page.getByText("Nothing in progress. When an agent sets a plan, it shows here.")).toBeVisible();
});
