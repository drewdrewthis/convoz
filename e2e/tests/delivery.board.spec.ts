import type { Page, TestInfo } from "@playwright/test";
import { convoz, createConversation, inboxItems, type AgentSession } from "../lib/chat.ts";
import { mainNav } from "../lib/chat-ui.ts";
import { openNow } from "../lib/asks.ts";
import { send } from "../lib/http.ts";
import { plainDb } from "../lib/machines.ts";
import { overflowX } from "../lib/mobile.ts";
import { mustPlan, planUi, planWorld, putPlan, type PlanWorld } from "../lib/plan.ts";
import { notes, settled } from "../lib/push-wp14.ts";
import { must } from "../lib/owner.ts";
import { memberDevice } from "../lib/security-wp18.ts";
import { expect, scenario } from "../lib/scenario.ts";

/*
 * DELIVERIES (delivery.feature, contracts/delivery.feature). Owner (Drew, conv 179, msg 9734). The contract the bindings rely on:
 *   `convoz plan <conv> [--deliver X --due 2d|1d4h|30m|HH:MM|"YYYY-MM-DD HH:MM"]...` adds a deliverable or moves its date; it stays across
 *   plan updates until `--done X` ships it. The printed plan has a line "Deliver: X · due Mon 2 Jan 15:04".
 *   GET /api/deliveries (owner only) -> {now, deliveries: [{conversation_id, title, identity_id, handle, text, due, since,
 *     state: late|waiting|at_risk|on_track, stale, doing, waiting, blocked?, plan_updated_at}], shipped: [{conversation_id, title, handle, text, at}],
 *     next_change_at?}
 *   When a due date passes the agent gets one inbox item "status_due" per date, whose text names the deliverable and asks "done, new date, or blocked?".
 * Page contract (/delivery): #daily is the daily line; each group is a region named by its label with an h2 "<label> · N"; each row is a link
 * to /chats/<conv> whose text holds the deliverable, its sub line "@agent · <state word> · <detail>" and its due text, and a glyph
 * (role img, named Late, At risk or Waiting on you) for a state that needs one. "Shipped today · N" is a chip that opens the shipped list.
 * Now: #overdue holds "Overdue · N", up to 3 rows and the link "See all deliveries". The desktop rail and the phone's bottom bar link "Deliveries".
 */

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

interface Delivery {
  conversation_id: number;
  title: string;
  handle: string;
  text: string;
  due: number;
  state: string;
  plan_updated_at: number;
}
interface Deliveries {
  now: number;
  deliveries: Delivery[];
  shipped: { text: string; handle: string; at: number }[];
}

/** GET /api/deliveries as the owner. */
async function deliveries(p: PlanWorld): Promise<Deliveries> {
  return must(await p.w.owner.client.get("/api/deliveries"), "read the deliveries").json() as Deliveries;
}

/** The same world with "docs" in its own conversation 42 "Docs refresh" (and not in 41). */
async function withDocs(p: PlanWorld): Promise<number> {
  return createConversation(p.w.owner, { title: "Docs refresh", participants: ["docs"] });
}

/** The owner opens Deliveries as a person would: from the rail on a computer, from the bottom bar on a phone. */
async function openDeliveries(page: Page, p: PlanWorld, info: TestInfo): Promise<void> {
  await page.goto(`${p.w.srv.origin}/`);
  const link = info.project.name === "mobile" ? mainNav(page).getByRole("link", { name: "Deliveries" }) : page.getByRole("navigation", { name: "Conversations" }).getByRole("link", { name: /^Deliveries/ });
  await link.click();
  await expect(page.getByRole("heading", { name: "Deliveries", exact: true })).toBeVisible();
}

const row = (page: Page, text: string) => page.locator("#deliveries").getByRole("link").filter({ hasText: text });

async function shoot(page: Page, info: TestInfo, name: string): Promise<void> {
  await page.screenshot({ path: info.outputPath(`${name}-${info.project.name}.png`), fullPage: true });
}

// ---- Rule: An agent names what it will deliver and by when, and it stays until it ships ----------------------------------------------

scenario("An agent sets a deliverable with a due date, and it stays until it ships", { tag: ["@cli"] }, async ({ server }) => {
  const p = await planWorld(server, { docsIn: false });

  // When "devtool" runs "convoz plan 41 --doing 'Filter chips' --eta 30m --deliver 'Search filters live' --due 2d"
  const res = await mustPlan(p, p.dev, ["--doing", "Filter chips", "--eta", "30m", "--deliver", "Search filters live", "--due", "2d"]);

  // Then the command prints "Deliver: Search filters live · due" and the date 2 days from now
  const first = await deliveries(p);
  expect(res.stdout).toContain("Deliver: Search filters live · due ");
  expect(first.deliveries).toHaveLength(1);
  expect(first.deliveries[0]!.due).toBe(first.deliveries[0]!.plan_updated_at + 2 * DAY);

  // When "devtool" runs "convoz plan 41 --doing 'Reply chip'"
  await mustPlan(p, p.dev, ["--doing", "Reply chip"]);

  // Then the owner's deliveries still list "Search filters live" for "devtool" in "Ship search filters", on track
  expect((await deliveries(p)).deliveries).toMatchObject([{ conversation_id: p.conv, title: "Ship search filters", handle: "devtool", text: "Search filters live", state: "on_track" }]);

  // When "devtool" runs "convoz plan 41 --deliver 'Search filters live' --due 3d"
  await mustPlan(p, p.dev, ["--deliver", "Search filters live", "--due", "3d"]);

  // Then the owner's deliveries list "Search filters live" once, due 3 days from now
  const moved = await deliveries(p);
  expect(moved.deliveries.map((d) => [d.text, d.due - d.plan_updated_at])).toEqual([["Search filters live", 3 * DAY]]);

  // When "devtool" runs "convoz plan 41 --done 'Search filters live'"
  await mustPlan(p, p.dev, ["--done", "Search filters live"]);

  // Then the owner's deliveries no longer list it, and list it as shipped
  const shipped = await deliveries(p);
  expect(shipped.deliveries).toEqual([]);
  expect(shipped.shipped).toMatchObject([{ text: "Search filters live", handle: "devtool" }]);
});

// ---- Rule: The owner sees every deliverable on one page: what to act on first, then by day ------------------------------------------

scenario("Deliveries shows what is late first, then what waits on the owner, then each day", { tag: ["@browser"] }, async ({ server, page, context, testApi }, info) => {
  info.setTimeout(90_000);
  const p = await planUi({ server, page, context }, { docsIn: false });
  const docsConv = await withDocs(p);
  // Given "devtool" delivers "Search filters live" in 30 minutes and "Reply chip" in 3 days
  await mustPlan(p, p.dev, ["--deliver", "Search filters live", "--due", "30m", "--deliver", "Reply chip", "--due", "3d"]);
  // And "docs" delivers "Docs refresh live" in 2 days and waits on the owner for "Approve the docs copy"
  const docsWaits = ["--waiting", "Approve the docs copy"];
  await mustPlan(p, p.docs, ["--deliver", "Docs refresh live", "--due", "2d", "--deliver", "README live", "--due", "1h", ...docsWaits], docsConv);

  // When 31 minutes pass
  await testApi(p.w.srv).advanceClock(31 * MIN);
  // And "docs" ships "README live"
  await mustPlan(p, p.docs, ["--done", "README live", ...docsWaits], docsConv);

  // And the owner opens Deliveries from the rail on a computer, or from the bottom bar on a phone
  if (info.project.name !== "mobile") {
    await page.goto(`${p.w.srv.origin}/`);
    await expect(page.getByRole("navigation", { name: "Conversations" }).getByRole("link", { name: /^Deliveries/ })).toContainText("1 late");
  }
  await openDeliveries(page, p, info);

  // Then the page reads "Shipped today 1 · Late 1" at the top
  await expect(page.locator("#daily")).toHaveText("Shipped today 1 · Late 1");

  // And the groups read "Late · 1", "Waiting on you · 1" and "This week · 1", in that order
  await expect(page.locator("#deliveries h2")).toHaveText(["Late · 1", "Waiting on you · 1", "This week · 1"]);

  // And the row "Search filters live" shows the glyph "Late", "Late · 1 min" and "@devtool · Late · was due" its time
  const late = row(page, "Search filters live");
  await expect(late.getByRole("img", { name: "Late" })).toBeVisible();
  await expect(late).toContainText("Late · 1 min");
  await expect(late).toContainText("@devtool · Late · was due ");
  await expect(page.getByRole("region", { name: "Late" })).toContainText("Search filters live");

  // And the row "Docs refresh live" shows the glyph "Waiting on you" and "@docs · Waiting on you"
  const waits = row(page, "Docs refresh live");
  await expect(waits.getByRole("img", { name: "Waiting on you" })).toBeVisible();
  await expect(waits).toContainText("@docs · Waiting on you");

  // And the row "Reply chip" shows "@devtool · On track"
  await expect(row(page, "Reply chip")).toContainText("@devtool · On track");
  await expect(row(page, "Reply chip").getByRole("img")).toHaveCount(0);

  // And on a phone the page does not scroll sideways
  if (info.project.name === "mobile") expect(await overflowX(page)).toBe(0);
  await shoot(page, info, "deliveries");

  // When the owner opens "Shipped today · 1"
  await page.getByRole("button", { name: "Shipped today · 1" }).click();
  // Then it lists "README live" by "@docs"
  await expect(page.getByRole("region", { name: "Shipped today" })).toContainText("README live");
  await expect(page.getByRole("region", { name: "Shipped today" })).toContainText("@docs");

  // When the owner taps the row "Search filters live"
  await late.click();
  // Then conversation 41 opens
  await expect(page).toHaveURL(new RegExp(`/chats/${p.conv}$`));
});

scenario("A deliverable whose plan is blocked or a day old shows as at risk", { tag: ["@browser"] }, async ({ server, page, context, testApi }, info) => {
  info.setTimeout(60_000);
  const p = await planUi({ server, page, context }, { docsIn: false });
  const docsConv = await withDocs(p);
  // Given "devtool" delivers "Search filters live" in 3 days
  await mustPlan(p, p.dev, ["--deliver", "Search filters live", "--due", "3d"]);
  // And "docs" delivers "Docs refresh live" in 3 days and is blocked on "CI is down"
  await mustPlan(p, p.docs, ["--deliver", "Docs refresh live", "--due", "3d", "--blocked", "CI is down"], docsConv);

  // When the owner opens Deliveries
  await openDeliveries(page, p, info);

  // Then the row "Docs refresh live" shows the glyph "At risk" and "@docs · At risk · Blocked: CI is down"
  await expect(row(page, "Docs refresh live").getByRole("img", { name: "At risk" })).toBeVisible();
  await expect(row(page, "Docs refresh live")).toContainText("@docs · At risk · Blocked: CI is down");
  // And the row "Search filters live" shows "@devtool · On track"
  await expect(row(page, "Search filters live")).toContainText("@devtool · On track");

  // When 25 hours pass with no plan update from "devtool" and the owner opens Deliveries again
  await testApi(p.w.srv).advanceClock(25 * HOUR);
  await page.reload();

  // Then the row "Search filters live" shows the glyph "At risk" and "no plan update since"
  const stale = row(page, "Search filters live");
  await expect(stale.getByRole("img", { name: "At risk" })).toBeVisible();
  await expect(stale).toContainText("@devtool · At risk · no plan update since ");
  // And it stays in its day group
  await expect(page.getByRole("region", { name: "Late" })).toHaveCount(0);
  await expect(page.locator("#deliveries h2")).toHaveText([/^(Tomorrow|This week) · 2$/]);
  await shoot(page, info, "deliveries-at-risk");
});

scenario("With no deliverables the page says how they come", { tag: ["@browser"] }, async ({ server, page, context }, info) => {
  const p = await planUi({ server, page, context }, { docsIn: false });
  // When the owner opens Deliveries
  await openDeliveries(page, p, info);
  // Then the page says "No deliveries yet. When an agent commits to a date, it shows here."
  await expect(page.getByText("No deliveries yet. When an agent commits to a date, it shows here.")).toBeVisible();
});

// ---- Rule: When a due date passes, the agent is asked first, once per date, and the owner sees it on Now without a push -------------

/** The status_due items in the agent's inbox. */
const dueItems = async (p: PlanWorld, who: AgentSession) => (await inboxItems(p.w.box, who.sid, [])).filter((i) => i.reason === "status_due");

scenario("When a due date passes, the agent is asked once: done, new date, or blocked", { tag: ["@cli"] }, async ({ server, dataDir, testApi }) => {
  const p = await planWorld(server, { docsIn: false, env: { CONVOZ_TEST_PLAINTEXT: "1" } });
  // Given "devtool" runs "convoz plan 41 --deliver 'Search filters live' --due 1h"
  await mustPlan(p, p.dev, ["--deliver", "Search filters live", "--due", "1h"]);

  // When 61 minutes pass
  await testApi(p.w.srv).advanceClock(61 * MIN);

  // Then "convoz inbox" of "devtool" gives one item with the reason "status_due" for conversation 41
  const due = await dueItems(p, p.dev);
  expect(due.map((i) => i.conversation.id)).toEqual([p.conv]);
  // And its message names "Search filters live" and asks "done, new date, or blocked?"
  expect(due[0]!.message.body).toContain('"Search filters live"');
  expect(due[0]!.message.body).toContain("done, new date, or blocked?");
  expect(due[0]!.message.body).toContain(`convoz plan ${p.conv} --deliver "Search filters live" --due`);

  // And the owner gets no push
  await settled(dataDir);
  expect(notes(dataDir).filter((n) => n.conversation_id === p.conv)).toEqual([]);

  // When "devtool" acks it and 3 more hours pass
  const ack = await convoz(p.w.box, p.dev.sid, ["ack", `${due[0]!.id}:${due[0]!.claim_token}`]);
  expect(ack.code, ack.stderr).toBe(0);
  await testApi(p.w.srv).advanceClock(3 * HOUR);
  // Then "devtool" gets no second item
  expect(await dueItems(p, p.dev)).toEqual([]);

  // When "devtool" runs "convoz plan 41 --deliver 'Search filters live' --due 2h" and 121 minutes pass
  await mustPlan(p, p.dev, ["--deliver", "Search filters live", "--due", "2h"]);
  await testApi(p.w.srv).advanceClock(121 * MIN);
  // Then "devtool" gets one more "status_due" item that names "Search filters live"
  const again = await dueItems(p, p.dev);
  expect(again).toHaveLength(1);
  expect(again[0]!.message.body).toContain('"Search filters live"');
});

scenario("A late step and a late delivery each ask once, with their own text", { tag: ["@cli"] }, async ({ server, testApi }) => {
  const p = await planWorld(server, { docsIn: false, env: { CONVOZ_TEST_PLAINTEXT: "1" } });
  // Given "devtool" runs "convoz plan 41 --doing 'Building invites' --eta 30m --deliver 'Search filters live' --due 1h"
  await mustPlan(p, p.dev, ["--doing", "Building invites", "--eta", "30m", "--deliver", "Search filters live", "--due", "1h"]);

  // When 31 minutes pass
  await testApi(p.w.srv).advanceClock(31 * MIN);
  // Then "devtool" gets one "status_due" item that names "Building invites" and does not ask about the delivery
  const step = await dueItems(p, p.dev);
  expect(step).toHaveLength(1);
  expect(step[0]!.message.body).toContain('"Building invites"');
  expect(step[0]!.message.body).not.toContain("done, new date, or blocked?");

  // When the due date passes while that item is not acked
  await testApi(p.w.srv).advanceClock(31 * MIN);
  // Then the same item still reads about the step
  const same = await dueItems(p, p.dev);
  expect(same).toHaveLength(1);
  expect(same[0]!.message.body).not.toContain("done, new date, or blocked?");

  // When "devtool" acks it
  const ack = await convoz(p.w.box, p.dev.sid, ["ack", `${same[0]!.id}:${same[0]!.claim_token}`]);
  expect(ack.code, ack.stderr).toBe(0);
  // Then "devtool" gets one "status_due" item that asks "done, new date, or blocked?" about "Search filters live"
  const delivery = await dueItems(p, p.dev);
  expect(delivery).toHaveLength(1);
  expect(delivery[0]!.message.body).toContain('"Search filters live"');
  expect(delivery[0]!.message.body).toContain("done, new date, or blocked?");

  // When "devtool" acks it and 90 minutes pass
  const ack2 = await convoz(p.w.box, p.dev.sid, ["ack", `${delivery[0]!.id}:${delivery[0]!.claim_token}`]);
  expect(ack2.code, ack2.stderr).toBe(0);
  await testApi(p.w.srv).advanceClock(90 * MIN);
  // Then no item asks about the delivery again
  expect((await dueItems(p, p.dev)).filter((i) => i.message.body.includes("done, new date, or blocked?"))).toEqual([]);
});

scenario("Now lists late deliverables under Overdue until the agent gives a new date", { tag: ["@browser"] }, async ({ server, page, context, testApi }, info) => {
  info.setTimeout(60_000);
  const p = await planUi({ server, page, context }, { docsIn: false });
  // Given "devtool" delivers "Search filters live" in 30 minutes
  await mustPlan(p, p.dev, ["--deliver", "Search filters live", "--due", "30m"]);

  // When 31 minutes pass and the owner opens Now
  await testApi(p.w.srv).advanceClock(31 * MIN);
  await openNow(page, p.w.srv);

  // Then Now shows "Overdue · 1" with "Search filters live" and "@devtool · was due" its time
  const overdue = page.locator("#overdue");
  await expect(overdue).toContainText("Overdue · 1");
  await expect(overdue.getByRole("link", { name: "Search filters live" })).toBeVisible();
  await expect(overdue).toContainText("@devtool · was due ");
  // And it does not say "All clear", and the Now badge does not count it
  await expect(page.getByText("All clear. Nothing needs you.")).toBeHidden();
  await expect(page.locator("#now-badge")).toBeHidden();
  await shoot(page, info, "now-overdue");

  // When the owner taps "See all deliveries"
  await overdue.getByRole("link", { name: "See all deliveries" }).click();
  // Then Deliveries opens
  await expect(page.getByRole("heading", { name: "Deliveries", exact: true })).toBeVisible();
  await expect(page).toHaveURL(/\/delivery$/);

  // When "devtool" runs "convoz plan 41 --deliver 'Search filters live' --due 2h"
  await mustPlan(p, p.dev, ["--deliver", "Search filters live", "--due", "2h"]);
  // And the owner opens Now
  await openNow(page, p.w.srv);
  // Then Now shows no "Overdue" group
  await expect(page.getByRole("heading", { name: "Now", exact: true })).toBeVisible();
  await expect(page.locator("#overdue")).toHaveCount(0);
});

// ---- Contracts ----------------------------------------------------------------------------------------------------------------------

scenario("Only the owner reads the deliveries", { tag: ["@api"] }, async ({ server, dataDir }) => {
  const p = await planWorld(server, { docsIn: false, env: { CONVOZ_TEST_PLAINTEXT: "1" } });
  // Given "devtool" sends PUT /api/conversations/41/plan with deliver "Search filters live" due "2d"
  must(await putPlan(p.w.srv, p.dev.lease, p.conv, { deliver: [{ text: "Search filters live", due: "2d" }] }), "put the plan");

  // When the owner sends GET /api/deliveries
  const res = must(await p.w.owner.client.get("/api/deliveries"), "read the deliveries");
  // Then the server answers 200 with one delivery
  const got = res.json() as Deliveries;
  expect(got.deliveries).toHaveLength(1);
  const d = got.deliveries[0]!;
  expect(d).toMatchObject({ conversation_id: p.conv, title: "Ship search filters", handle: "devtool", text: "Search filters live", state: "on_track" });
  expect(d.due).toBe(d.plan_updated_at + 2 * DAY);

  // And "devtool" gets 401 or 403 for the same GET with its lease
  const lease = await send(p.w.srv.target, "GET", "/api/deliveries", { headers: { Authorization: `Bearer ${p.dev.lease}` } });
  expect([401, 403]).toContain(lease.status);

  // And a member who is not the owner gets 403
  const member = memberDevice(plainDb(dataDir));
  expect((await send(p.w.srv.target, "GET", "/api/deliveries", { cookie: member })).status).toBe(403);
});

scenario("A due date is a duration, a time or a date ahead, and a plan holds at most 5 deliverables", { tag: ["@api"] }, async ({ server }) => {
  const p = await planWorld(server, { docsIn: false });
  const put = (deliver: { text: string; due: string }[], done?: string[]) => putPlan(p.w.srv, p.dev.lease, p.conv, { deliver, ...(done ? { done } : {}) });
  const field = (res: { json: () => { error: { field?: string } } }) => res.json().error.field;

  // When "devtool" sends a plan with deliver "A" due "tomorrow"
  const word = await put([{ text: "A", due: "tomorrow" }]);
  // Then the server answers 400 with the field "due"
  expect([word.status, field(word)]).toEqual([400, "due"]);
  // And a plan with deliver "A" due "2026-01-01 10:00" (in the past) answers 400 with the field "due"
  const past = await put([{ text: "A", due: "2026-01-01 10:00" }]);
  expect([past.status, field(past)]).toEqual([400, "due"]);

  // And a plan with 5 deliverables due "2d", "18:00", "1d4h", "30m" and "60d" is accepted
  const five = ["2d", "18:00", "1d4h", "30m", "60d"].map((due, i) => ({ text: "ABCDE"[i]!, due }));
  expect((await put(five)).status).toBe(200);

  // And one more deliverable "F" due "2d" answers 400 with the field "deliver", and the plan keeps its 5
  const sixth = await put([{ text: "F", due: "2d" }]);
  expect([sixth.status, field(sixth)]).toEqual([400, "deliver"]);
  expect((await deliveries(p)).deliveries.map((d) => d.text).sort()).toEqual(["A", "B", "C", "D", "E"]);

  // And a plan with done "A" ships "A" and keeps 4
  expect((await put([], ["A"])).status).toBe(200);
  const after = await deliveries(p);
  expect(after.deliveries.map((d) => d.text).sort()).toEqual(["B", "C", "D", "E"]);
  expect(after.shipped.map((s) => s.text)).toEqual(["A"]);
});
