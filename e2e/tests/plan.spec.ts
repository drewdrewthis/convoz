import type { Locator, Page } from "@playwright/test";
import { convoz, createConversation, inboxItems, messagesOf, ownerSays, startWatch } from "../lib/chat.ts";
import { appReturns, chatList, chatRow, dropStreams, streamOpen } from "../lib/chat-ui.ts";
import { openNow } from "../lib/asks.ts";
import { McpClient } from "../lib/agent-wp7.ts";
import { stepped } from "../lib/machines.ts";
import { overflowX } from "../lib/mobile.ts";
import {
  attentionOf, board, clockIn, detailsPanel, mustPlan, plan, planLine, planOf, planUi, planWorld, putPlan, quietLine, rowIcon, type PlanWorld,
} from "../lib/plan.ts";
import { decrypt, newSub, notes, received, settled, sleep, subscribe } from "../lib/push-wp14.ts";
import { must } from "../lib/owner.ts";
import { showDetails } from "../lib/wp3.ts";
import { expect, scenario } from "../lib/scenario.ts";

// plan.feature. The contract is the block at the top of lib/plan.ts.

const MIN = 60_000;
const HOUR = 60 * MIN;

// ---- Rule: An agent keeps one plan per conversation, replaced whole by one command --------------------------------------

scenario("An agent sets its plan with one command", { tag: ["@cli"] }, async ({ server }) => {
  const p = await planWorld(server);

  // When "devtool" runs "convoz plan 41 --doing 'Building invites' --eta 30m --next 'Reply chip' --next 'Faster first load' --waiting 'Approve the dot card'"
  const res = await mustPlan(p, p.dev, ["--doing", "Building invites", "--eta", "30m", "--next", "Reply chip", "--next", "Faster first load", "--waiting", "Approve the dot card"]);

  // Then the command prints the plan
  expect(res.stdout).toContain("Doing: Building invites");
  expect(res.stdout).toContain("Next: Reply chip");
  expect(res.stdout).toContain("Waiting on you: Approve the dot card");

  // And Crew shows "devtool" as "working" with "Building invites"
  const crew = must(await p.w.owner.client.get("/api/status"), "crew").json().statuses as { handle: string; state: string; doing: string }[];
  expect(crew.find((c) => c.handle === "devtool")).toMatchObject({ state: "working", doing: "Building invites" });

  // When "devtool" runs "convoz plan 41 --doing 'Reply chip' --done 'Building invites'"
  await mustPlan(p, p.dev, ["--doing", "Reply chip", "--done", "Building invites"]);

  // Then the whole plan was replaced
  const mine = await planOf(p, "devtool");
  expect(mine).toMatchObject({ doing: "Reply chip", next: [], waiting: [] });
  expect(mine!.done.map((d) => d.text)).toEqual(["Building invites"]);

  // And the plan of "docs" is still empty
  expect(await planOf(p, "docs")).toBeUndefined();
});

scenario("A plan keeps its limits", { tag: ["@cli"] }, async ({ server }) => {
  const p = await planWorld(server);

  // When "devtool" runs "convoz plan 41" with 6 "--next" items
  const six = await plan(p, p.dev, ["--doing", "x", ...[1, 2, 3, 4, 5, 6].flatMap((i) => ["--next", `Item ${i}`])]);

  // Then it exits 2 and says "--next is at most 5 items"
  expect(six.code).toBe(2);
  expect(six.stderr).toContain("--next is at most 5 items");

  // When "devtool" finishes 5 items one plan at a time
  for (let i = 1; i <= 5; i++) await mustPlan(p, p.dev, ["--done", `Item ${i}`]);

  // Then all 5 Done items are kept, newest first
  expect((await planOf(p, "devtool"))!.done.map((d) => d.text)).toEqual(["Item 5", "Item 4", "Item 3", "Item 2", "Item 1"]);
});

scenario("An agent sets its plan with the plan tool", { tag: ["@mcp"] }, async ({ server }) => {
  const p = await planWorld(server);
  const mcp = await McpClient.start(p.w.box, "devtool", "claude-TESTONLY-plan");
  try {
    // When "devtool" calls the MCP tool "plan" with conversation 41, doing "Building invites" and next "Reply chip"
    const out = await mcp.tool("plan", { conversation: p.conv, doing: "Building invites", next: ["Reply chip"] });

    // Then the tool answers with the plan
    expect(out.isError ?? false, JSON.stringify(out)).toBe(false);
    expect(JSON.stringify(out)).toContain("Building invites");

    // And the stored plan is Doing "Building invites" and Next "Reply chip"
    expect(await planOf(p, "devtool")).toMatchObject({ doing: "Building invites", next: ["Reply chip"] });
  } finally {
    mcp.end();
  }
});

// ---- Rule: Up to 3 Now items, for an agent that works in parallel (owner msg 659) ---------------------------------------

scenario("An agent working in parallel shows up to 3 Now items, each with its own estimate", { tag: ["@cli"] }, async ({ server, testApi }) => {
  const p = await planWorld(server, { docsIn: false, env: { CONVOZ_TEST_PLAINTEXT: "1" } });

  // When "devtool" runs "convoz plan 41 --doing 'Fix #8675 findings' --eta 30m --step 1/4 --doing 'Build #8798' --eta 2h"
  const res = await mustPlan(p, p.dev, ["--doing", "Fix #8675 findings", "--eta", "30m", "--step", "1/4", "--doing", "Build #8798", "--eta", "2h"]);

  // Then the command prints both Now items, the first with "step 1 of 4"
  expect(res.stdout).toContain("Doing: Fix #8675 findings (step 1 of 4)");
  expect(res.stdout).toContain("Doing: Build #8798");

  // And the plan has 2 Now items, each with its own estimate
  const mine = (await planOf(p, "devtool"))!;
  expect(mine.now?.map((n) => n.text)).toEqual(["Fix #8675 findings", "Build #8798"]);
  expect(mine.now![0]!.step).toEqual({ at: 1, of: 4 });
  expect(mine.now![1]!.eta! - mine.now![0]!.eta!).toBeGreaterThan(80 * MIN);
  expect(mine.now![1]!.step).toBeUndefined();

  // And the line under the title reads the first item
  expect((await board(p)).attention[0]).toMatchObject({ state: "working", text: "Fix #8675 findings", more: 1 });

  // When 31 minutes pass with no update
  await testApi(p.w.srv).advanceClock(31 * MIN);

  // Then the plan is late by the first item, and the line shows it with "+1"
  expect((await board(p)).attention[0]).toMatchObject({ state: "late", text: "Fix #8675 findings", more: 1 });
  // And the nudge to "devtool" names "Fix #8675 findings"
  const due = (await inboxItems(p.w.box, p.dev.sid, [])).filter((i) => i.reason === "status_due");
  expect(due).toHaveLength(1);
  expect(due[0]!.message.body).toContain("Fix #8675 findings");
});

scenario("The plan tool takes up to 3 Now items, each with its own estimate", { tag: ["@mcp"] }, async ({ server }) => {
  const p = await planWorld(server);
  const mcp = await McpClient.start(p.w.box, "devtool", "claude-TESTONLY-plan-par");
  try {
    // When "devtool" calls the MCP tool "plan" with doing a list of two items, each with its own eta
    const out = await mcp.tool("plan", { conversation: p.conv, doing: [{ text: "Fix #8675 findings", eta: "30m", step: "1/4" }, { text: "Build #8798", eta: "2h" }] });
    expect(out.isError ?? false, JSON.stringify(out)).toBe(false);

    // Then the plan has those 2 Now items, each with its own estimate
    const mine = (await planOf(p, "devtool"))!;
    expect(mine.now?.map((n) => n.text)).toEqual(["Fix #8675 findings", "Build #8798"]);
    expect(mine.now![0]!.step).toEqual({ at: 1, of: 4 });
    expect(mine.now!.every((n) => n.eta)).toBe(true);

    // When "devtool" calls the tool with doing as the single text "Build #8798"
    const one = await mcp.tool("plan", { conversation: p.conv, doing: "Build #8798" });
    expect(one.isError ?? false, JSON.stringify(one)).toBe(false);

    // Then the plan has 1 Now item "Build #8798"
    expect((await planOf(p, "devtool"))!.now?.map((n) => n.text)).toEqual(["Build #8798"]);
  } finally {
    mcp.end();
  }
});

scenario("A fourth --doing is refused with a clear message", { tag: ["@cli"] }, async ({ server }) => {
  const p = await planWorld(server);
  // When "devtool" runs "convoz plan 41" with 4 "--doing" items
  const four = await plan(p, p.dev, [1, 2, 3, 4].flatMap((i) => ["--doing", `Item ${i}`]));
  // Then it exits 2 and says "--doing is at most 3 items"
  expect(four.code).toBe(2);
  expect(four.stderr).toContain("--doing is at most 3 items");
  // When "devtool" runs "convoz plan 41 --eta 30m"
  const lone = await plan(p, p.dev, ["--eta", "30m"]);
  // Then it exits 2 and says "--eta needs a --doing before it"
  expect(lone.code).toBe(2);
  expect(lone.stderr).toContain("--eta needs a --doing before it");
});

// ---- Rule: One line under the title shows the most urgent state across the agents ---------------------------------------

scenario("The line under the title shows the most urgent state", { tag: ["@browser"] }, async ({ server, page, context, testApi }, info) => {
  info.setTimeout(180_000);
  const rows: { setup(p: PlanWorld): Promise<void>; line(p: PlanWorld): Promise<string>; tone: string }[] = [
    {
      // "devtool" works on "Building invites" ready in 30 minutes | "docs" has finished "Write the README"
      setup: async (p) => {
        await mustPlan(p, p.dev, ["--doing", "Building invites", "--eta", "30m"]);
        await mustPlan(p, p.docs, ["--done", "Write the README"]);
      },
      line: async (p) => `Working · Building invites · ready ~${await clockIn(page, (await planOf(p, "devtool"))!.eta!)}`,
      tone: "green",
    },
    {
      // "devtool" has finished "One-time invites" and plans nothing more | "docs" has no plan
      setup: async (p) => void (await mustPlan(p, p.dev, ["--done", "One-time invites"])),
      line: async () => "Done · nothing planned",
      tone: "grey",
    },
    {
      // "devtool" was due 30 minutes ago with no update | "docs" works on "Docs" ready in 1 hour
      setup: async (p) => {
        await mustPlan(p, p.dev, ["--doing", "Building invites", "--eta", "30m"]);
        await testApi(p.w.srv).advanceClock(60 * MIN);
        await mustPlan(p, p.docs, ["--doing", "Docs", "--eta", "1h"]);
      },
      line: async (p) => `Late · was due ${await clockIn(page, (await planOf(p, "devtool"))!.eta!)}`,
      tone: "amber",
    },
    {
      // "devtool" works on "Building invites" and is blocked on "needs Tailscale ACL change" | "docs" was due 30 minutes ago
      setup: async (p) => {
        await mustPlan(p, p.docs, ["--doing", "Docs", "--eta", "30m"]);
        await testApi(p.w.srv).advanceClock(60 * MIN);
        await mustPlan(p, p.dev, ["--doing", "Building invites", "--blocked", "needs Tailscale ACL change"]);
      },
      line: async () => "Blocked: needs Tailscale ACL change",
      tone: "red",
    },
    {
      // "devtool" waits on the owner for "Approve the dot card" | "docs" is blocked on "a missing key"
      setup: async (p) => {
        await mustPlan(p, p.dev, ["--doing", "Building invites", "--waiting", "Approve the dot card"]);
        await mustPlan(p, p.docs, ["--doing", "Docs", "--blocked", "a missing key"]);
      },
      line: async () => "Waiting on you: Approve the dot card",
      tone: "amber",
    },
  ];
  // one owner and one browser; each row is its own conversation with both agents, so no row sees another's plans
  const world = await planUi({ server, page, context });
  for (const [i, row] of rows.entries()) {
    const p: PlanWorld = { ...world, conv: await createConversation(world.w.owner, { title: `Row ${i + 1}`, participants: ["devtool", "docs"] }) };
    // Given <devtool> and <docs>
    await row.setup(p);
    // When the owner opens conversation 41
    await page.goto(`${p.w.srv.origin}/chats/${p.conv}`);
    // Then the line under the title reads "<line>" with a <tone> dot
    const want = await row.line(p);
    await expect(planLine(page)).toHaveText(want);
    await expect(planLine(page).locator("[data-tone]")).toHaveAttribute("data-tone", row.tone);
  }
});

// ---- Rule: Tapping the line opens the details panel -----------------------------------------------------------------------

scenario("The details panel puts what waits on the owner first, then each agent's plan, then the settings", { tag: ["@browser"] }, async ({ server, page, context }) => {
  const p = await planUi({ server, page, context });
  // Given "devtool" finished five items, then planned Doing at step 2 of 3 ready in 15 minutes, two Next and one Waiting on you
  await mustPlan(p, p.dev, ["--done", "One-time invites", "--done", "Reply chip v0", "--done", "Invite page", "--done", "Rename sheet", "--done", "Search fix"]);
  await mustPlan(p, p.dev, ["--doing", "Switch on the internet door", "--step", "2/3", "--eta", "15m", "--next", "Reply chip", "--next", "Faster first load", "--waiting", "Paste the prompt to dot"]);

  // When the owner opens conversation 41 and taps the line under the title
  await page.goto(`${p.w.srv.origin}/chats/${p.conv}`);
  await planLine(page).click();
  const panel = detailsPanel(page);
  await expect(panel).toBeVisible();

  // Then the panel shows "Waiting on you · 1", then "Agents · 2", then "Conversation", in that order
  await expect(panel.getByRole("heading", { level: 3 })).toHaveText(["Waiting on you · 1", "Agents · 2", "Pinned in this conversation", "Conversation"]);

  // And "Paste the prompt to dot" shows "I did it" and "Reply" and no "Open", as it has no link
  const waiting = panel.getByRole("region", { name: "Waiting on you · 1" });
  await expect(waiting).toContainText("Paste the prompt to dot");
  await expect(waiting.getByRole("button", { name: "I did it" })).toBeVisible();
  await expect(waiting.getByRole("button", { name: "Reply" })).toBeVisible();
  await expect(waiting.getByRole("link", { name: "Open" })).toHaveCount(0);

  // And the card of "@devtool" shows "Working", Now with "Step 2 of 3" and "ready ~", and Next numbered
  const agents = panel.getByRole("region", { name: "Agents · 2" });
  const dev = agents.getByRole("listitem").filter({ hasText: "@devtool" }).first();
  await expect(dev).toContainText("Working");
  await expect(dev).toContainText("Switch on the internet door");
  // msg 646: the step is a bar (named "Step 2 of 3"), and the time is one muted line, so it no longer reads "Step 2 of 3 · ready ~"
  await expect(dev.getByRole("img", { name: "Step 2 of 3" })).toBeVisible();
  await expect(dev).toContainText("ready ~");
  await expect(dev.getByRole("list", { name: "Next" }).getByRole("listitem")).toHaveText(["Reply chip", "Faster first load"]);

  // And its Done items are folded as "Done · 5"; tapping it shows all 5 under "Today"
  await dev.getByRole("button", { name: "Done · 5" }).click();
  const done = dev.getByRole("list", { name: "Done" });
  await expect(done.getByRole("listitem")).toHaveText([/Search fix/, /Rename sheet/, /Invite page/, /Reply chip v0/, /One-time invites/]);
  await expect(done).toContainText("Today");

  // And the card of "@docs" shows "No plan yet" and "Ask for a plan"
  const docs = agents.getByRole("listitem").filter({ hasText: "@docs" });
  await expect(docs).toContainText("No plan yet");
  await expect(docs.getByRole("button", { name: "Ask for a plan" })).toBeVisible();

  // And at 320 pixels wide the panel has no sideways scroll and every button is at least 44 pixels tall
  await page.setViewportSize({ width: 320, height: 700 });
  await expect.poll(() => overflowX(page)).toBe(0);
  const short = await panel.locator("button, a.chipbtn").evaluateAll((list) => list.filter((b) => b.getBoundingClientRect().height > 0 && b.getBoundingClientRect().height < 43.5).map((b) => b.textContent));
  expect(short).toEqual([]);

  // When the owner taps "I did it", then the chat shows the owner's message and the item shows "You said it is done"
  await waiting.getByRole("button", { name: "I did it" }).click();
  await expect(waiting).toContainText("You said it is done");
  await expect.poll(async () => (await messagesOf(p.w.owner, p.conv)).map((m) => m.body)).toContain("@devtool I did it: Paste the prompt to dot");
});

scenario("Ask for a plan tells the agent the command that sets it", { tag: ["@browser"] }, async ({ server, page, context }) => {
  const p = await planUi({ server, page, context });
  // Given "docs" has no plan in conversation 41
  // When the owner opens the details of conversation 41 and taps "Ask for a plan" on the card of "@docs"
  await page.goto(`${p.w.srv.origin}/chats/${p.conv}`);
  const panel = await showDetails(page); // no agent has a plan, so there is no line under the title to tap
  const docs = panel.getByRole("region", { name: "Agents · 2" }).getByRole("listitem").filter({ hasText: "@docs" });
  await docs.getByRole("button", { name: "Ask for a plan" }).click();

  // Then the chat shows the owner's message to "@docs" with "convoz plan 41 --doing" and "not a chat message"
  const sent = async () => (await messagesOf(p.w.owner, p.conv)).map((m) => m.body).find((b) => b.startsWith("@docs, please set your plan")) ?? "";
  await expect.poll(sent).toContain(`convoz plan ${p.conv} --doing`);
  expect(await sent()).toContain("not a chat message");
  // And it names the MCP "plan" tool and "convoz plan --help"
  expect(await sent()).toContain("use the `plan` tool");
  expect(await sent()).toContain("convoz plan --help");
});

scenario("The plan card puts Remove in a menu and shows the step as a bar", { tag: ["@browser"] }, async ({ server, page, context }) => {
  const p = await planUi({ server, page, context });
  // Given "devtool" finished "One-time invites" and planned Doing "Switch on the internet door" at step 2 of 3 ready in 15 minutes and Next "Reply chip"
  await mustPlan(p, p.dev, ["--done", "One-time invites"]);
  await mustPlan(p, p.dev, ["--doing", "Switch on the internet door", "--step", "2/3", "--eta", "15m", "--next", "Reply chip", "--waiting", "Paste the prompt to dot"]);
  await mustPlan(p, p.docs, ["--doing", "Docs", "--blocked", "needs Tailscale ACL change"]);

  // When the owner opens the details of conversation 41
  await page.goto(`${p.w.srv.origin}/chats/${p.conv}`);
  const panel = await showDetails(page);
  const dev = panel.getByRole("region", { name: "Agents · 2" }).getByRole("listitem").filter({ hasText: "@devtool" }).first();

  // Then the card shows "Working", "updated" and a menu button, and no "Remove" button
  await expect(dev).toContainText("Working");
  await expect(dev).toContainText("updated");
  await expect(dev.getByRole("button", { name: "More for @devtool" })).toBeVisible();
  await expect(dev.getByRole("button", { name: "Remove @devtool" })).toHaveCount(0);
  // And Now shows the title with a step bar at 2 of 3 and "ready ~"
  await expect(dev.locator(".pnow")).toContainText("Switch on the internet door");
  await expect(dev.getByRole("img", { name: "Step 2 of 3" })).toBeVisible();
  await expect(dev.locator(".pnow")).toContainText("ready ~");
  await expect(dev).not.toContainText("no estimate");
  await page.screenshot({ path: "/tmp/plancard-desktop.png" });

  // And at 320 pixels wide the panel has no sideways scroll and every button is at least 44 pixels tall
  await page.setViewportSize({ width: 320, height: 700 });
  await expect.poll(() => overflowX(page)).toBe(0);
  const short = await panel.locator("button, a.chipbtn").evaluateAll((list) => list.filter((b) => b.getBoundingClientRect().height > 0 && b.getBoundingClientRect().height < 43.5).map((b) => b.textContent));
  expect(short).toEqual([]);
  await dev.scrollIntoViewIfNeeded();
  await page.screenshot({ path: "/tmp/plancard-phone.png" });

  // When the owner opens the menu and taps "Remove"
  await dev.getByRole("button", { name: "More for @devtool" }).click();
  await page.getByRole("menuitem", { name: "Remove @devtool" }).click();
  // Then "@devtool" is removed at once and a toast offers Undo, as before
  await expect(page.getByText("Removed @devtool")).toBeVisible();
});

scenario("The card and the line show each parallel Now item with its own estimate", { tag: ["@browser"] }, async ({ server, page, context }) => {
  const p = await planUi({ server, page, context });
  // Given "devtool" planned Doing "Fix #8675 findings" at step 1 of 4 ready in 30 minutes and Doing "Build #8798" ready in 2 hours
  await mustPlan(p, p.dev, ["--doing", "Fix #8675 findings", "--step", "1/4", "--eta", "30m", "--doing", "Build #8798", "--eta", "2h"]);
  // When the owner opens conversation 41
  await page.goto(`${p.w.srv.origin}/chats/${p.conv}`);
  // Then the line under the title reads "Working · Fix #8675 findings" with "+1"
  await expect(planLine(page)).toContainText("Working · Fix #8675 findings");
  await expect(planLine(page)).toContainText("+1");
  // When the owner taps the line
  await planLine(page).click();
  // Then the card shows two Now blocks, each with its own "ready ~", and the step bar only on the first
  const dev = detailsPanel(page).getByRole("region", { name: "Agents · 2" }).getByRole("listitem").filter({ hasText: "@devtool" }).first();
  const blocks = dev.locator(".pnow");
  await expect(blocks).toHaveCount(2);
  await expect(blocks.nth(0)).toContainText("Fix #8675 findings");
  await expect(blocks.nth(0)).toContainText("ready ~");
  await expect(blocks.nth(0).getByRole("img", { name: "Step 1 of 4" })).toBeVisible();
  await expect(blocks.nth(1)).toContainText("Build #8798");
  await expect(blocks.nth(1)).toContainText("ready ~");
  await expect(blocks.nth(1).getByRole("img")).toHaveCount(0);
});

scenario("The panel says when an agent is late or blocked", { tag: ["@browser"] }, async ({ server, page, context, testApi }) => {
  const p = await planUi({ server, page, context });
  // Given "devtool" planned Doing ready in 30 minutes, and 31 minutes passed with no update
  await mustPlan(p, p.dev, ["--doing", "Building invites", "--eta", "30m"]);
  await testApi(p.w.srv).advanceClock(31 * MIN);
  // And "docs" planned Doing "Docs" and is blocked on "needs Tailscale ACL change"
  await mustPlan(p, p.docs, ["--doing", "Docs", "--blocked", "needs Tailscale ACL change"]);

  // When the owner opens conversation 41 and taps the line under the title
  await page.goto(`${p.w.srv.origin}/chats/${p.conv}`);
  await planLine(page).click();
  const agents = detailsPanel(page).getByRole("region", { name: "Agents · 2" });

  // Then the card of "@devtool" shows "Late", "Was due" and "Ask for an update"
  const dev = agents.getByRole("listitem").filter({ hasText: "@devtool" }).first();
  await expect(dev).toContainText("Late");
  await expect(dev).toContainText("Was due");
  await expect(dev.getByRole("button", { name: "Ask for an update" })).toBeVisible();

  // And the card of "@docs" shows "Blocked" and "Blocked: needs Tailscale ACL change"
  const docs = agents.getByRole("listitem").filter({ hasText: "@docs" }).first();
  await expect(docs).toContainText("Blocked: needs Tailscale ACL change");
});

// ---- Rule: Each row of the Conversations list shows a small status icon next to its count -------------------------------

scenario("Each conversation row shows a status icon next to its count and the list never reorders", { tag: ["@browser"] }, async ({ server, page, context }) => {
  const p = await planUi({ server, page, context }, { docsIn: false });
  // Given conversations "Working one", "Waiting one", "Blocked one" and "Quiet one" with "devtool"
  const ids: Record<string, number> = {};
  for (const title of ["Working one", "Waiting one", "Blocked one", "Quiet one"]) {
    ids[title] = must(await p.w.owner.client.post("/api/conversations", { client_id: `claude-TESTONLY-${title.replace(" ", "")}`, title, participants: ["devtool"] }), title, 201).json().conversation.id;
  }
  // And "devtool" works in "Working one", waits on the owner in "Waiting one" and is blocked in "Blocked one"
  await mustPlan(p, p.dev, ["--doing", "Building invites"], ids["Working one"]);
  await mustPlan(p, p.dev, ["--doing", "Building invites", "--waiting", "Approve the dot card"], ids["Waiting one"]);
  await mustPlan(p, p.dev, ["--doing", "Building invites", "--blocked", "needs a key"], ids["Blocked one"]);
  // And "devtool" posted in "Working one", so it has an unread count
  const posted = await convoz(p.w.box, p.dev.sid, ["post", String(ids["Working one"]), "Started"]);
  expect(posted.code, posted.stderr).toBe(0);

  // When the owner opens the Conversations list
  await page.goto(`${p.w.srv.origin}/chats`);
  const order = ["Quiet one", "Blocked one", "Waiting one", "Working one", "Ship search filters"];
  await expect(chatList(page).getByRole("heading")).toHaveText(order);

  // Then "Working one" shows a green icon named "Working", right of its title, next to its count and as tall as it
  const working = chatRow(page, "Working one");
  await expect(rowIcon(working)).toHaveAccessibleName("Working");
  await expect(rowIcon(working)).toHaveAttribute("data-tone", "green");
  await expect(rowIcon(working)).toHaveAttribute("title", "Working");
  const icon = (await rowIcon(working).boundingBox())!;
  const title = (await working.getByRole("heading").boundingBox())!;
  const count = (await working.locator(".count").boundingBox())!;
  expect(icon.x).toBeGreaterThan(title.x + title.width);
  expect(Math.abs(count.x - (icon.x + icon.width))).toBeLessThanOrEqual(8);
  expect(Math.abs(icon.height - count.height)).toBeLessThanOrEqual(2);

  // And the other rows: amber "Waiting on you", red "Blocked", and no icon for "Quiet one"
  await expect(rowIcon(chatRow(page, "Waiting one"))).toHaveAccessibleName("Waiting on you");
  await expect(rowIcon(chatRow(page, "Waiting one"))).toHaveAttribute("data-tone", "amber");
  await expect(rowIcon(chatRow(page, "Blocked one"))).toHaveAccessibleName("Blocked");
  await expect(rowIcon(chatRow(page, "Blocked one"))).toHaveAttribute("data-tone", "red");
  await expect(rowIcon(chatRow(page, "Quiet one"))).toHaveCount(0);

  // And no row has an avatar
  await expect(chatList(page).locator(".ava, .avatar, [class*='ring']")).toHaveCount(0);

  // And the rows keep their order, also when a plan changes live
  await mustPlan(p, p.dev, ["--doing", "Something new"], ids["Quiet one"]);
  await expect(rowIcon(chatRow(page, "Quiet one"))).toHaveAccessibleName("Working");
  await expect(chatList(page).getByRole("heading")).toHaveText(order);
});

// ---- Rule: Updates come live; only something new that waits on the owner pushes ------------------------------------------

scenario("The line and the panel update live, and a quiet line marks a finished item", { tag: ["@browser"] }, async ({ server, page, context }) => {
  const p = await planUi({ server, page, context });
  // Given the owner has conversation 41 open and "devtool" works on "One-time invites"
  await mustPlan(p, p.dev, ["--doing", "One-time invites"]);
  await page.goto(`${p.w.srv.origin}/chats/${p.conv}`);
  await expect(planLine(page)).toHaveText("Working · One-time invites");

  // When "devtool" runs "convoz plan 41 --done 'One-time invites' --doing 'Switch on the internet door' --eta 20m"
  await mustPlan(p, p.dev, ["--done", "One-time invites", "--doing", "Switch on the internet door", "--eta", "20m"]);

  // Then the line reads "Working · Switch on the internet door" without a reload
  const first = (await planOf(p, "devtool"))!.eta!;
  await expect(planLine(page)).toHaveText(`Working · Switch on the internet door · ready ~${await clockIn(page, first)}`);

  // And the chat shows the quiet line
  // msg 632: the quiet line is now one row, "@devtool updated its plan", with Now beside it; Done shows when the row opens
  const quiet = quietLine(page, "@devtool updated its plan");
  await expect(quiet).toHaveCount(1);
  await expect(quiet).toContainText("Now: Switch on the internet door");

  // When "devtool" only moves its ready time to 40 minutes
  await mustPlan(p, p.dev, ["--doing", "Switch on the internet door", "--eta", "40m"]);

  // Then the line shows the new time and no new quiet line appears
  const moved = (await planOf(p, "devtool"))!.eta!;
  await expect(planLine(page)).toHaveText(`Working · Switch on the internet door · ready ~${await clockIn(page, moved)}`);
  await sleep(500);
  await expect(quietLine(page, "@devtool updated its plan")).toHaveCount(1); // msg 632: the row's new words
});

scenario("A plan update in the chat is one quiet row that expands", { tag: ["@browser"] }, async ({ server, page, context }) => {
  const p = await planUi({ server, page, context });
  // Given "devtool" works on "One-time invites" and the owner has conversation 41 open
  await mustPlan(p, p.dev, ["--doing", "One-time invites"]);
  await page.goto(`${p.w.srv.origin}/chats/${p.conv}`);
  await expect(planLine(page)).toBeVisible();

  // When "devtool" runs "convoz plan 41 --done 'One-time invites' --doing 'Switch on the internet door' --waiting 'Approve the dot card'"
  await mustPlan(p, p.dev, ["--done", "One-time invites", "--doing", "Switch on the internet door", "--next", "Reply chip", "--waiting", "Approve the dot card"]);

  // Then the chat shows one row "@devtool updated its plan" with "Now: Switch on the internet door" and the pill "Waiting on you · 1"
  const row = quietLine(page, "@devtool updated its plan");
  await expect(row).toHaveCount(1);
  await expect(row).toContainText("Now: Switch on the internet door");
  const pill = row.getByRole("button", { name: "Waiting on you · 1" });
  await expect(pill).toBeVisible();
  // And the row is collapsed and shows no "Done:" line, and is not a list bullet
  await expect(row.getByText("Done", { exact: true })).toHaveCount(0);
  await page.screenshot({ path: "/tmp/planline-collapsed.png" });

  // When the owner taps the row
  await row.getByRole("button", { name: /updated its plan/ }).click();
  // Then it shows the labelled lines "Done" "One-time invites", "Now", "Next" and "Waiting"
  for (const [label, text] of [["Done", "One-time invites"], ["Now", "Switch on the internet door"], ["Next", "Reply chip"], ["Waiting", "Approve the dot card"]]) {
    await expect(row.getByText(label!, { exact: true })).toBeVisible();
    await expect(row).toContainText(text!);
  }
  await page.screenshot({ path: "/tmp/planline-expanded.png" });

  // When the owner taps the pill "Waiting on you · 1"
  await pill.click();
  // Then the details panel opens
  await expect(detailsPanel(page)).toBeVisible();
});

scenario("Only something new that waits on the owner pushes", { tag: ["@api"] }, async ({ server, dataDir }, info) => {
  info.setTimeout(90_000);
  const p = await planWorld(server, { env: { CONVOZ_TEST_PLAINTEXT: "1" } });
  // Given the owner's browser has a push subscription to the fake push service
  await settled(dataDir);
  const sub = newSub();
  must(await subscribe(p.w.owner, sub), "subscribe", 201);
  // And "devtool" works on "Building invites" ready in 30 minutes
  const base = { doing: "Building invites", eta: "30m" };
  must(await putPlan(p.w.srv, p.dev.lease, p.conv, base), "plan");
  await settled(dataDir);
  const pushes = async () => (await received(p.w.srv)).length;

  const rows: { change: string; body: Record<string, unknown>; push: boolean }[] = [
    { change: '"devtool" adds "Approve the dot card" to Waiting on you', body: { ...base, waiting: ["Approve the dot card"] }, push: true },
    { change: '"devtool" finishes "Building invites"', body: { done: ["Building invites"], waiting: ["Approve the dot card"] }, push: false },
    { change: '"devtool" moves its ready time to 1 hour', body: { doing: "Next thing", eta: "1h", waiting: ["Approve the dot card"] }, push: false },
  ];
  for (const row of rows) {
    const before = { pushes: await pushes(), rows: notes(dataDir).length };
    // When <change>
    must(await putPlan(p.w.srv, p.dev.lease, p.conv, row.body), row.change);
    await settled(dataDir);
    if (row.push) {
      // Then the fake push service receives one push with the reason "plan_waiting"
      await expect.poll(pushes, { timeout: 15_000, message: row.change }).toBe(before.pushes + 1);
      const shown = decrypt(sub, (await received(p.w.srv)).at(-1)!);
      expect(shown.reason).toBe("plan_waiting");
      expect(shown.body ?? "").toContain("Approve the dot card");
    } else {
      // Then the fake push service receives nothing
      await sleep(1_500);
      expect(await pushes(), row.change).toBe(before.pushes);
      expect(notes(dataDir).length, row.change).toBe(before.rows);
    }
  }
});

// ---- Rule: An agent that goes quiet is nudged, and the owner sees it without a push --------------------------------------

scenario("A late agent is nudged once to update its plan, and the owner is not pushed", { tag: ["@cli"] }, async ({ server, dataDir, testApi }) => {
  const p = await planWorld(server, { docsIn: false, env: { CONVOZ_TEST_PLAINTEXT: "1" } });
  // Given "devtool" runs "convoz plan 41 --doing 'Building invites' --eta 30m"
  await mustPlan(p, p.dev, ["--doing", "Building invites", "--eta", "30m"]);

  // When 31 minutes pass with no plan or status update from "devtool"
  await testApi(p.w.srv).advanceClock(31 * MIN);

  // Then the line of conversation 41 is "Late"
  expect(await attentionOf(p)).toBe("late");

  // And "convoz inbox" gives one item with the reason "status_due" for conversation 41 that asks it to update its plan
  const due = (await inboxItems(p.w.box, p.dev.sid, [])).filter((i) => i.reason === "status_due");
  expect(due).toHaveLength(1);
  expect(due[0]!.conversation.id).toBe(p.conv);
  expect(due[0]!.message.body).toContain(`convoz plan ${p.conv}`);

  // And the owner gets no push
  await settled(dataDir);
  expect(notes(dataDir).filter((n) => n.conversation_id === p.conv)).toEqual([]);

  // When "devtool" acks it and 10 more minutes pass, then no second nudge
  const ack = await convoz(p.w.box, p.dev.sid, ["ack", `${due[0]!.id}:${due[0]!.claim_token}`]);
  expect(ack.code, ack.stderr).toBe(0);
  await testApi(p.w.srv).advanceClock(10 * MIN);
  expect((await inboxItems(p.w.box, p.dev.sid, [])).filter((i) => i.reason === "status_due")).toEqual([]);

  // When 2 more hours pass, then one more "status_due" item
  await testApi(p.w.srv).advanceClock(2 * HOUR);
  expect((await inboxItems(p.w.box, p.dev.sid, [])).filter((i) => i.reason === "status_due")).toHaveLength(1);

  // When "devtool" plans again, the line is "Working" again
  await mustPlan(p, p.dev, ["--doing", "Building invites", "--eta", "30m"]);
  expect(await attentionOf(p)).toBe("working");
});

scenario("A working agent with no update for 2 hours is nudged", { tag: ["@cli"] }, async ({ server, testApi }) => {
  const p = await planWorld(server, { docsIn: false });
  // Given "devtool" runs "convoz plan 41 --doing 'Building invites'"
  await mustPlan(p, p.dev, ["--doing", "Building invites"]);

  // When 2 hours and 1 minute pass with no update from "devtool"
  await testApi(p.w.srv).advanceClock(2 * HOUR + MIN);

  // Then the line reads "Building invites · no update for 2 h"
  const a = (await board(p, p.conv)).attention.find((x) => x.conversation_id === p.conv);
  expect(a).toMatchObject({ state: "stale", text: "Building invites" });

  // And "convoz inbox" gives one item with the reason "status_due" for conversation 41
  const due = (await inboxItems(p.w.box, p.dev.sid, [])).filter((i) => i.reason === "status_due");
  expect(due.map((i) => i.conversation.id)).toEqual([p.conv]);
});

scenario("An agent that does not pick up a message shows as not responding", { tag: ["@browser"] }, async ({ server, page, context, testApi, dataDir }, info) => {
  info.setTimeout(90_000);
  const p = await planUi({ server, page, context }, { docsIn: false, env: { CONVOZ_TEST_PLAINTEXT: "1" } });
  // Given "devtool" has a live session but does not run "convoz watch", and the owner has conversation 41 open
  await page.goto(`${p.w.srv.origin}/chats/${p.conv}`);
  await expect(page.getByRole("heading", { name: "Ship search filters" })).toBeVisible();

  // When the owner sends "Is the build green?" and 10 minutes pass
  await ownerSays(p.w.owner, p.conv, "Is the build green?");
  await testApi(p.w.srv).advanceClock(10 * MIN);

  // Then the line under the title reads "Not responding · last seen" in amber
  await expect(planLine(page)).toContainText("Not responding · last seen", { timeout: 15_000 });
  await expect(planLine(page).locator("[data-tone]")).toHaveAttribute("data-tone", "amber");

  // And the chat shows the quiet line "@devtool is not responding" once
  await expect(quietLine(page, "@devtool is not responding")).toHaveCount(1);
  await sleep(11_000); // a second sweep of the timers must not write the line again
  await expect(quietLine(page, "@devtool is not responding")).toHaveCount(1);

  // And the Conversations list shows an amber icon named "Not responding" for conversation 41
  await page.goto(`${p.w.srv.origin}/chats`);
  await expect(rowIcon(chatRow(page, "Ship search filters"))).toHaveAccessibleName("Not responding");
  await expect(rowIcon(chatRow(page, "Ship search filters"))).toHaveAttribute("data-tone", "amber");

  // And the owner gets no push for it
  expect(notes(dataDir).filter((n) => n.conversation_id === p.conv)).toEqual([]);

  // When "devtool" starts "convoz watch", then the line no longer says "Not responding"
  await page.goto(`${p.w.srv.origin}/chats/${p.conv}`);
  await expect(planLine(page)).toContainText("Not responding");
  const watch = startWatch(p.w.box, p.dev.sid);
  try {
    // with no plan and a live watch there is nothing to say, so the line may go away entirely
    // allInnerTexts reads without waiting: a count then innerText would wait forever for a line that went away in between
    await expect.poll(async () => (await planLine(page).allInnerTexts()).join(""), { timeout: 15_000 }).not.toContain("Not responding");
  } finally {
    watch.stop();
  }
});

scenario("An agent whose machine key was revoked shows as logged out", { tag: ["@browser"] }, async ({ server, page, context, testApi }) => {
  const p = await planWorld(server, { docsIn: false });
  // Given the owner sent "Is the build green?" in conversation 41
  await ownerSays(p.w.owner, p.conv, "Is the build green?");

  // When the owner revokes the key of machine "box-2" and 10 minutes pass (its step-up comes before the browser takes the passkey)
  must(await stepped(p.w.owner, "POST", `/api/machines/${p.w.box2.id}/revoke`, {}, "machine.revoke", p.w.box2.id), "revoke box-2");
  await testApi(p.w.srv).advanceClock(10 * MIN);

  // Then the line under the title of conversation 41 reads "Logged out" in amber
  const { recordStreams } = await import("../lib/chat-ui.ts");
  const { signInBrowser } = await import("../lib/machines.ts");
  await recordStreams(context);
  await signInBrowser(p.w.srv, p.w.owner, page, context);
  await page.goto(`${p.w.srv.origin}/chats/${p.conv}`);
  await expect(planLine(page)).toContainText("Logged out");
  await expect(planLine(page).locator("[data-tone]")).toHaveAttribute("data-tone", "amber");
});

// ---- Rule: What an agent waits on the owner for shows in Now ------------------------------------------------------------

const waitingRows = (page: Page): Locator => page.getByRole("region", { name: "Waiting on you" }).getByRole("link");

scenario("A plan item waiting on the owner shows in Now", { tag: ["@browser"] }, async ({ server, page, context }) => {
  const p = await planUi({ server, page, context });
  // Given "devtool" waits on the owner for "Approve the dot card" in conversation 41
  await mustPlan(p, p.dev, ["--doing", "Building invites", "--waiting", "Approve the dot card"]);

  // When the owner opens Now
  await openNow(page, p.w.srv);

  // Then Now lists the item under "Waiting on you" with the agent and the conversation title
  await expect(waitingRows(page)).toHaveCount(1);
  await expect(waitingRows(page).first()).toContainText("Approve the dot card");
  await expect(waitingRows(page).first()).toContainText("@devtool");
  await expect(waitingRows(page).first()).toContainText("Ship search filters");

  // And the top bar says "1 open"
  await expect(page.locator("#open-count")).toContainText("1 open");

  // When the owner taps the row, then conversation 41 opens with its details panel showing "Waiting on you · 1"
  await waitingRows(page).first().click();
  await expect(page).toHaveURL(new RegExp(`/chats/${p.conv}`));
  await expect(detailsPanel(page).getByRole("heading", { name: "Waiting on you · 1" })).toBeVisible();
});

scenario("A waiting item leaves Now when the agent finishes it", { tag: ["@browser"] }, async ({ server, page, context }, info) => {
  info.setTimeout(90_000);
  const p = await planUi({ server, page, context });
  // Given "devtool" waits on the owner for "Approve the dot card" and the owner has Now open
  await mustPlan(p, p.dev, ["--doing", "Building invites", "--waiting", "Approve the dot card"]);
  await openNow(page, p.w.srv);
  await expect(waitingRows(page)).toHaveCount(1);
  await streamOpen(page);

  // When "devtool" runs "convoz plan 41 --done 'Approve the dot card'"
  await mustPlan(p, p.dev, ["--done", "Approve the dot card"]);

  // Then Now no longer lists it and says "0 open", without a reload
  await expect(waitingRows(page)).toHaveCount(0, { timeout: 4_000 });
  await expect(page.locator("#open-count")).toContainText("0 open");
});

scenario("A waiting item missed while offline shows after reconnect", { tag: ["@browser"] }, async ({ server, page, context }, info) => {
  info.setTimeout(90_000);
  const p = await planUi({ server, page, context });
  // Given the owner has Now open and the live stream is cut
  await openNow(page, p.w.srv);
  await streamOpen(page);
  expect(await dropStreams(page)).toBeGreaterThan(0);

  // When "devtool" adds a waiting item and the app reconnects
  await mustPlan(p, p.dev, ["--doing", "Building invites", "--waiting", "Approve the dot card"]);
  await appReturns(page);

  // Then Now lists it under "Waiting on you" without a reload
  await expect(waitingRows(page)).toHaveCount(1, { timeout: 5_000 });
  await expect(waitingRows(page).first()).toContainText("Approve the dot card");
});
