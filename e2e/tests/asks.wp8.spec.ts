import { convoz, createConversation, inboxItems, messagesOf, ownerSays, unreadOf } from "../lib/chat.ts";
import {
  QUESTION,
  agentAsks,
  answerAsk,
  answerMessages,
  askBody,
  askCard,
  askOf,
  askWorld,
  expectState,
  markAsk,
  nowOf,
  openNow,
  postAsk,
  snoozeAsk,
  withdrawAsk,
  type AskView,
} from "../lib/asks.ts";
import { send } from "../lib/http.ts";
import { bearer, revokeAgentKey, lease as mintLease, plainDb } from "../lib/machines.ts";
import { must } from "../lib/owner.ts";
import { expect, scenario } from "../lib/scenario.ts";
import { agentDeletes, agentEdits, ownerDeletes, pageOf } from "../lib/messages-wp4.ts";
import { browserWorld, idsOf, machineWith, ownerRemoves } from "../lib/wp3.ts";

/*
 * ASKS (WP8): the bindings of specs/features/asks.feature and specs/contracts/asks.feature. The routes, bodies and answers are the
 * contract block at the top of lib/asks.ts (packages/contracts/paths/ask.yaml). The first option of an ask is the recommended one.
 * An agent asks with `convoz ask <conv> --question Q --recommend L --why W --alt L --alt-why W [--urgent] [--thread ROOT]`.
 * The ask card of Now is an article named by the question; the card of a conversation is the same component.
 */

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// ---- asks.feature ---------------------------------------------------------------------------------------------

scenario("A complete ask opens", { tag: ["@cli"] }, async ({ server }) => {
  // Given "devtool" and "docs" are active participants of conversation 41 "Ship search filters"
  const { w, conv, devtool } = await askWorld(server);

  // When "devtool" runs "convoz ask 41 --question 'Merge #415 on its own?' --recommend 'Merge it' --why 'All 11 checks pass' --alt 'Hold it' --alt-why 'Wait for #412'"
  const ran = await convoz(w.box, devtool.sid, [
    "ask", String(conv), "--question", QUESTION, "--recommend", "Merge it", "--why", "All 11 checks pass", "--alt", "Hold it", "--alt-why", "Wait for #412",
  ]);
  expect({ code: ran.code, stderr: ran.stderr }).toEqual({ code: 0, stderr: "" });

  // Then the owner sees the ask in Now with "Merge it" marked recommended
  const now = await nowOf(w.owner);
  expect(now.asks.map((a) => [a.question, a.asker.handle, a.options[0]?.label, a.options[0]?.recommended, a.options[1]?.recommended ?? false])).toEqual([
    [QUESTION, "devtool", "Merge it", true, false],
  ]);

  // And conversation 41 shows the ask card with both options and their reasons
  const card = (await pageOf(w.owner, conv)).find((m) => m.kind === "ask") as unknown as { ask: AskView; body: string };
  expect(card.ask.options.map((o) => [o.label, o.why])).toEqual([
    ["Merge it", "All 11 checks pass"],
    ["Hold it", "Wait for #412"],
  ]);
});

scenario("The answer is posted where the ask was asked", { tag: ["@browser"] }, async ({ server, page, context, dataDir, testApi }, info) => {
  info.setTimeout(90_000);
  // Given an ask of "devtool" posted as a reply in thread 900
  const w = await browserWorld({ server, page, context }, { agents: ["devtool", "docs"], live: ["devtool"] });
  const conv = await createConversation(w.owner, { title: "Ship search filters", participants: ["devtool", "docs"] });
  const root = await ownerSays(w.owner, conv, "Which branch do we ship?");
  const id = await agentAsks(w.srv, w.sessions.devtool!.lease, conv, { thread: root });

  // When the owner answers "Hold it" from Now
  await openNow(page, w.srv);
  await askCard(page).getByRole("button", { name: "Hold it", exact: true }).click();
  await expect.poll(async () => (await askOf(w.owner, id)).state, { message: "the ask was not answered" }).toBe("answered");

  // Then thread 900 shows the answer message "Hold it"
  const thread = await messagesOf(w.owner, conv, `thread=${root}`);
  expect(thread.map((m) => m.body)).toContain("Hold it");

  // And the main list of conversation 41 does not
  const main = await messagesOf(w.owner, conv, "limit=100");
  expect(main.map((m) => m.body)).not.toContain("Hold it");
});

scenario("Undismiss clears the agent's ack", { tag: ["@cli"] }, async ({ server }) => {
  // Given "devtool" acked the dismissal of its ask
  const { w, conv, devtool } = await askWorld(server);
  const id = await agentAsks(w.srv, devtool.lease, conv);
  must(await markAsk(w.owner, id, "dismiss"), "dismiss");
  const resolved = async () => (await inboxItems(w.box, devtool.sid, ["--claim", "5", "--wait", "0"])).filter((i) => i.reason === "ask_resolved");
  const [first] = await resolved();
  expect(first?.claim_token, "no ask_resolved item for the dismissal").toBeTruthy();
  const acked = await convoz(w.box, devtool.sid, ["ack", `${first!.id}:${first!.claim_token}`]);
  expect(acked.code).toBe(0);
  expect((await askOf(w.owner, id)).acked_at, "the ack is not on the ask").toBeGreaterThan(0);

  // When the owner undismisses the ask and then answers "Merge it"
  must(await markAsk(w.owner, id, "undismiss"), "undismiss");
  must(await answerAsk(w.owner, id, { choice: "recommended" }), "answer");

  // Then "devtool" gets a new "ask_resolved" item for that ask
  const items = await resolved();
  expect(items.map((i) => [i.reason, (i.message as unknown as { id: number }).id, (i.message as unknown as { ask?: AskView }).ask?.answer])).toEqual([["ask_resolved", id, "Merge it"]]);
  expect(items[0]!.id).not.toBe(first!.id);

  // And the owner no longer sees "Seen by @devtool" until "devtool" acks again
  expect((await askOf(w.owner, id)).acked_at).toBeUndefined();
  const again = await convoz(w.box, devtool.sid, ["ack", `${items[0]!.id}:${items[0]!.claim_token}`]);
  expect(again.code).toBe(0);
  expect((await askOf(w.owner, id)).acked_at).toBeGreaterThan(0);
});

scenario("Removing the asker closes its open and dismissed asks", { tag: ["@api"] }, async ({ server }) => {
  // Given "devtool" has an open ask and a dismissed ask in conversation 41
  const { w, conv, devtool } = await askWorld(server);
  const open = await agentAsks(w.srv, devtool.lease, conv, { question: "Open question?" });
  const dismissed = await agentAsks(w.srv, devtool.lease, conv, { question: "Dismissed question?" });
  must(await markAsk(w.owner, dismissed, "dismiss"), "dismiss");

  // When the owner removes "devtool" from conversation 41
  const ids = await idsOf(w.owner);
  must(await ownerRemoves(w.owner, conv, ids.devtool!), "remove devtool");

  // Then both asks are "closed (removed)"
  expect([await expectState(w.owner, open), await expectState(w.owner, dismissed)]).toEqual(["closed (removed)", "closed (removed)"]);

  // And Now no longer shows them
  const now = await nowOf(w.owner);
  expect([now.asks.length, now.snoozed.length, now.answered_today.length, now.badge]).toEqual([0, 0, 0, 0]);
});

scenario("Disabling the asker closes its asks everywhere", { tag: ["@api"] }, async ({ server }) => {
  // Given "devtool" has open asks in conversations 41 and 52
  const { w, conv, devtool } = await askWorld(server);
  const conv52 = await createConversation(w.owner, { title: "Release prep", participants: ["devtool"] });
  const a = await agentAsks(w.srv, devtool.lease, conv, { question: "Ask in 41?" });
  const b = await agentAsks(w.srv, devtool.lease, conv52, { question: "Ask in 52?" });

  // When the owner disables "devtool" with a passkey
  const ids = await idsOf(w.owner);
  must(await revokeAgentKey(w.owner, ids.devtool), "disable devtool");

  // Then both asks are "closed (agent_revoked)"
  expect([await expectState(w.owner, a), await expectState(w.owner, b)]).toEqual(["closed (agent_revoked)", "closed (agent_revoked)"]);
  expect((await nowOf(w.owner)).badge).toBe(0);
});

scenario("Deleting an open ask message closes the ask", { tag: ["@api"] }, async ({ server }) => {
  // Given an open ask of "devtool"
  const { w, conv, devtool } = await askWorld(server);
  const id = await agentAsks(w.srv, devtool.lease, conv);

  // When "devtool" deletes the ask message
  must(await agentDeletes(w.srv, devtool.lease, id), "delete the ask message");

  // Then the ask is "closed (deleted)"
  expect(await expectState(w.owner, id)).toBe("closed (deleted)");

  // And "devtool" gets an "ask_resolved" item
  const items = await inboxItems(w.box, devtool.sid, ["--peek"]);
  expect(items.filter((i) => i.reason === "ask_resolved").map((i) => (i.message as unknown as { id: number }).id)).toEqual([id]);
});

scenario("Deleting an answered ask keeps the decision", { tag: ["@api"] }, async ({ server }) => {
  // Given an ask of "devtool" answered with "Merge it"
  const { w, conv, devtool } = await askWorld(server);
  const id = await agentAsks(w.srv, devtool.lease, conv);
  must(await answerAsk(w.owner, id, { choice: "recommended" }), "answer");

  // When the owner deletes the ask message
  must(await ownerDeletes(w.owner, id), "delete the ask message");

  // Then the message shows as deleted
  const tomb = (await pageOf(w.owner, conv, "limit=100")).find((m) => m.id === id);
  expect(tomb?.deleted).toBe(true);

  // And the ask still shows "Answered · Merge it"
  const ask = await askOf(w.owner, id);
  expect([ask.state, ask.close_reason, ask.answer]).toEqual(["answered", undefined, "Merge it"]);
});

scenario("A quick reply answers with custom text", { tag: ["@browser"] }, async ({ server, page, context, dataDir, testApi }, info) => {
  info.setTimeout(90_000);
  // Given an open ask of "devtool"
  const w = await browserWorld({ server, page, context }, { agents: ["devtool", "docs"], live: ["devtool"] });
  const conv = await createConversation(w.owner, { title: "Ship search filters", participants: ["devtool", "docs"] });
  const id = await agentAsks(w.srv, w.sessions.devtool!.lease, conv);

  // When the owner opens Quick reply on the ask and sends "Split it in two"
  await openNow(page, w.srv);
  const card = askCard(page);
  await card.getByRole("button", { name: "Quick reply" }).click();
  await card.getByRole("textbox", { name: "Quick reply" }).fill("Split it in two");
  await card.getByRole("button", { name: "Send", exact: true }).click();

  // Then the ask shows "Replied · Split it in two"
  await expect(page.getByText("Replied · Split it in two")).toBeVisible();

  // And "devtool" gets an "ask_resolved" item with the custom text
  const items = await inboxItems(w.box, w.sessions.devtool!.sid, ["--peek"]);
  const mine = items.filter((i) => i.reason === "ask_resolved").map((i) => (i.message as unknown as { id: number; ask: AskView }));
  expect(mine.map((m) => [m.id, m.ask.chosen])).toEqual([[id, { kind: "custom", text: "Split it in two" }]]);
});

scenario("A double tap on an option answers once", { tag: ["@browser"] }, async ({ server, page, context, dataDir, testApi }, info) => {
  info.setTimeout(90_000);
  // Given an open ask of "devtool"
  const w = await browserWorld({ server, page, context }, { agents: ["devtool", "docs"], live: ["devtool"], plaintext: true });
  const conv = await createConversation(w.owner, { title: "Ship search filters", participants: ["devtool", "docs"] });
  const id = await agentAsks(w.srv, w.sessions.devtool!.lease, conv);
  const seen: number[] = [];
  page.on("response", (r) => {
    if (r.request().method() === "POST" && r.url().endsWith(`/api/asks/${id}/answer`)) seen.push(r.status());
  });

  // When the owner taps "Merge it" twice quickly
  await openNow(page, w.srv);
  await askCard(page).getByRole("button", { name: "Merge it", exact: true }).dblclick();
  await expect.poll(async () => (await askOf(w.owner, id)).state).toBe("answered");
  await sleep(500);

  // Then conversation 41 shows one answer message
  expect(answerMessages(dataDir, id).map((m) => m.body)).toEqual(["Merge it"]);
  expect(seen.length, "the page sent no answer").toBeGreaterThan(0);
  expect(seen.every((s) => s === 200), `every answer request of the page was 200, got ${seen}`).toBe(true);

  // And the second request returns the first result
  const first = await askOf(w.owner, id);
  const second = await answerAsk(w.owner, id, { choice: "recommended" });
  expect(second.status).toBe(200);
  expect([second.json().ask.version, second.json().ask.answer]).toEqual([first.version, "Merge it"]);
  expect(answerMessages(dataDir, id).length).toBe(1);
});

scenario("A plain message does not answer an ask", { tag: ["@api"] }, async ({ server }) => {
  // Given an open ask of "devtool"
  const { w, conv, devtool } = await askWorld(server);
  const id = await agentAsks(w.srv, devtool.lease, conv);

  // When the owner posts "thinking about it" in conversation 41
  await ownerSays(w.owner, conv, "thinking about it");

  // Then the ask is still "open" in Now
  const now = await nowOf(w.owner);
  expect(now.asks.map((a) => [a.id, a.state])).toEqual([[id, "open"]]);
});

scenario("The ask history shows who dismissed it", { tag: ["@browser"] }, async ({ server, page, context, dataDir, testApi }, info) => {
  info.setTimeout(90_000);
  // Given an open ask of "devtool"
  const w = await browserWorld({ server, page, context }, { agents: ["devtool", "docs"], live: ["devtool"] });
  const conv = await createConversation(w.owner, { title: "Ship search filters", participants: ["devtool", "docs"] });
  const id = await agentAsks(w.srv, w.sessions.devtool!.lease, conv);

  // When the owner dismisses it, undismisses it and then answers "Merge it"
  must(await markAsk(w.owner, id, "dismiss"), "dismiss");
  must(await markAsk(w.owner, id, "undismiss"), "undismiss");
  must(await answerAsk(w.owner, id, { choice: "recommended" }), "answer");

  // Then the ask's history lists "Dismissed by Drew", "Reopened by Drew" and "Answered by Drew · Merge it" with their times
  await page.goto(`${w.srv.origin}/chats/${conv}`);
  const card = askCard(page);
  await card.getByRole("button", { name: "History" }).click();
  const rows = await card.getByRole("list", { name: "History" }).getByRole("listitem").allInnerTexts();
  const wanted = ["Dismissed by Drew", "Reopened by Drew", "Answered by Drew · Merge it"];
  const at = wanted.map((text) => rows.findIndex((r) => r.includes(text)));
  expect(at.every((i) => i >= 0) && at[0]! < at[1]! && at[1]! < at[2]!, `history rows: ${JSON.stringify(rows)}`).toBe(true);
  expect(at.every((i) => /\d{1,2}:\d{2}/.test(rows[i]!)), "every history row shows its time").toBe(true);

  // And "devtool" sees the same history with "convoz read 41"
  const read = await convoz(w.box, w.sessions.devtool!.sid, ["read", String(conv)]);
  expect(read.code).toBe(0);
  const order = wanted.map((text) => read.stdout.indexOf(text));
  expect(order.every((i) => i >= 0) && order[0]! < order[1]! && order[1]! < order[2]!, `convoz read printed:\n${read.stdout}`).toBe(true);
});

scenario("Answering removes the snooze", { tag: ["@api"] }, async ({ server }) => {
  // Given an open ask of "devtool" snoozed by the owner until tomorrow
  const { w, conv, devtool } = await askWorld(server);
  const id = await agentAsks(w.srv, devtool.lease, conv);
  must(await snoozeAsk(w.owner, id, { preset: "tomorrow", tz: "UTC" }), "snooze until tomorrow");
  expect((await nowOf(w.owner)).snoozed.map((a) => a.id)).toEqual([id]);

  // When the owner answers it
  must(await answerAsk(w.owner, id, { choice: "recommended" }), "answer");

  // Then Now no longer lists it under snoozed
  const now = await nowOf(w.owner);
  expect([now.snoozed.length, now.asks.length, now.answered_today.map((a) => a.id)]).toEqual([0, 0, [id]]);
});

scenario("Only an open ask can be snoozed", { tag: ["@browser"] }, async ({ server, page, context, dataDir, testApi }, info) => {
  info.setTimeout(90_000);
  // Given an ask of "devtool" that the owner dismissed
  const w = await browserWorld({ server, page, context }, { agents: ["devtool", "docs"], live: ["devtool"] });
  const conv = await createConversation(w.owner, { title: "Ship search filters", participants: ["devtool", "docs"] });
  const dismissed = await agentAsks(w.srv, w.sessions.devtool!.lease, conv, { question: "Dismissed question?" });
  await agentAsks(w.srv, w.sessions.devtool!.lease, conv, { question: "Open question?" });
  must(await markAsk(w.owner, dismissed, "dismiss"), "dismiss");

  // When the owner opens the ask's menu
  await page.goto(`${w.srv.origin}/chats/${conv}`);
  await askCard(page, "Open question?").getByRole("button", { name: "Ask options" }).click();
  await expect(page.getByRole("menuitem", { name: "Snooze" }), "an open ask can be snoozed").toBeVisible();
  await page.keyboard.press("Escape");
  await askCard(page, "Dismissed question?").getByRole("button", { name: "Ask options" }).click();

  // Then the menu has no Snooze item
  await expect(page.getByRole("menu")).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Snooze" })).toHaveCount(0);
});

// ---- contracts/asks.feature -----------------------------------------------------------------------------------

scenario("An incomplete or oversized ask is refused", { tag: ["@api"] }, async ({ server }) => {
  // Given "devtool" and "docs" are active participants of conversation 41 "Ship search filters"
  const { w, conv, devtool } = await askWorld(server);
  const valid = askBody(conv);
  const long = (n: number) => "x".repeat(n);
  const rows: [string, Record<string, unknown>, string][] = [
    ["no alternative", { ...valid, alternatives: [] }, "alternatives"],
    ["an empty reason for the recommendation", { ...valid, recommended: { label: "Merge it", why: "" } }, "why"],
    ["a reason of 281 characters", { ...valid, recommended: { label: "Merge it", why: long(281) } }, "why"],
    ["5 alternatives", { ...valid, alternatives: [1, 2, 3, 4, 5].map((i) => ({ label: `Option ${i}`, why: "because" })) }, "alternatives"],
    ["a question of 501 characters", { ...valid, question: long(501) }, "question"],
  ];
  for (const [problem, body, field] of rows) {
    // When "devtool" posts an ask with <problem>
    const res = await postAsk(w.srv, devtool.lease, { ...body, client_id: `claude-TESTONLY-${Math.random().toString(16).slice(2, 12)}` });

    // Then the server answers 400 naming "<field>"
    expect([problem, res.status, res.status === 400 ? res.json().error.field : res.text]).toEqual([problem, 400, field]);

    // And Now shows no new ask
    expect((await nowOf(w.owner)).asks, problem).toEqual([]);
  }
});

scenario("Only an agent with the ask scope asks", { tag: ["@api"] }, async ({ server }) => {
  // Given machine "laptop-1" has no ask scope and runs "docs"
  const { w, conv } = await askWorld(server);
  const laptop = await machineWith(w.srv, w.owner, "laptop-1", ["docs"], ["read", "post"]);
  const docsOnLaptop = await mintLease(w.srv, laptop.login.key, { as: "docs" });

  // When "docs" on "laptop-1" posts a valid ask
  const res = await postAsk(w.srv, docsOnLaptop, askBody(conv));

  // Then the server answers 403
  expect(res.status).toBe(403);
});

scenario("A human cannot post an ask", { tag: ["@api"] }, async ({ server }) => {
  // Given "devtool" and "docs" are active participants of conversation 41 "Ship search filters"
  const { w, conv } = await askWorld(server);

  // When the owner posts a valid ask with the device cookie
  const res = await w.owner.client.post("/api/asks", askBody(conv));

  // Then the server answers 403
  expect(res.status).toBe(403);
});

scenario("An identity holds at most 20 open asks", { tag: ["@api"] }, async ({ server }) => {
  // Given "devtool" has 20 open asks
  const { w, conv, devtool } = await askWorld(server);
  const others = [];
  for (let i = 0; i < 3; i++) others.push(await createConversation(w.owner, { title: `Topic ${i}`, participants: ["devtool"] }));
  const homes = [conv, ...others];
  for (let i = 0; i < 20; i++) await agentAsks(w.srv, devtool.lease, homes[i % homes.length]!, { question: `Question ${i + 1}?` });
  expect((await nowOf(w.owner)).asks.length).toBe(20);

  // When "devtool" posts another valid ask
  const res = await postAsk(w.srv, devtool.lease, askBody(others[0]!, { question: "One too many?" }));

  // Then the server answers 429 with the code "ask_cap"
  expect([res.status, res.status === 429 ? res.json().error.code : res.text]).toEqual([429, "ask_cap"]);
});

scenario("Ask content never changes after it is posted", { tag: ["@api", "@invariant"] }, async ({ server, dataDir }) => {
  // Given an open ask of "devtool" with the question "Merge #415 on its own?"
  const { w, conv, devtool } = await askWorld(server, { plaintext: true });
  const id = await agentAsks(w.srv, devtool.lease, conv);

  // When "devtool" tries to edit the ask message or its options
  const edit = await agentEdits(w.srv, devtool.lease, id, { body: "Merge #415 and #416?" });
  const options = await send(w.srv.target, "PATCH", `/api/asks/${id}`, { json: { options: [{ label: "x", why: "y" }] }, ...bearer(devtool.lease) });
  const db = plainDb(dataDir);
  let sealed: string;
  try {
    sealed = (() => {
      try {
        db.prepare("UPDATE ask_options SET label = 'Merge it now' WHERE message_id = ?").run(id);
        return "changed";
      } catch (e) {
        return String(e);
      }
    })();
  } finally {
    db.close();
  }

  // Then the server refuses the change
  expect([edit.status, options.status === 404 || options.status === 405, sealed]).toEqual([400, true, expect.stringContaining("immutable")]);

  // And GET /api/now shows the original question and options
  const now = await nowOf(w.owner);
  expect(now.asks.map((a) => [a.question, a.options.map((o) => o.label)])).toEqual([[QUESTION, ["Merge it", "Hold it"]]]);
});

scenario("Ask transitions", { tag: ["@api"] }, async ({ server }) => {
  // Given "devtool" and "docs" are active participants of conversation 41 "Ship search filters"
  const { w, conv, devtool, docs } = await askWorld(server);
  type Actor = "owner" | "devtool" | "docs";
  const rows: [from: string, actor: Actor, event: string, status: number, to: string][] = [
    ["open", "owner", "answer", 200, "answered"],
    ["open", "owner", "dismiss", 200, "dismissed"],
    ["dismissed", "owner", "answer", 200, "answered"],
    ["dismissed", "owner", "undismiss", 200, "open"],
    ["dismissed", "owner", "dismiss", 200, "dismissed"],
    ["open", "devtool", "withdraw", 200, "closed (withdrawn)"],
    ["dismissed", "devtool", "withdraw", 200, "closed (withdrawn)"],
    ["answered", "owner", "dismiss", 409, "answered"],
    ["answered", "devtool", "withdraw", 409, "answered"],
    ["closed", "owner", "answer", 409, "closed"],
    ["open", "docs", "withdraw", 403, "open"],
    ["answered", "owner", "answer", 200, "answered"],
    ["answered", "owner", "answer-other", 409, "answered"],
    ["open", "owner", "snooze", 200, "open"],
    ["dismissed", "owner", "snooze", 409, "dismissed"],
    ["answered", "owner", "snooze", 409, "answered"],
  ];
  const leases = { devtool: devtool.lease, docs: docs.lease };
  let n = 0;
  for (const [from, actor, event, status, to] of rows) {
    // Given an ask of "devtool" in state "<from>"
    const id = await agentAsks(w.srv, devtool.lease, conv, { question: `Transition ${++n}: ${from} then ${event}?` });
    if (from === "dismissed") must(await markAsk(w.owner, id, "dismiss"), `${from}: dismiss`);
    if (from === "answered") must(await answerAsk(w.owner, id, { choice: "recommended" }), `${from}: answer`);
    if (from === "closed") must(await withdrawAsk(w.srv, devtool.lease, id), `${from}: withdraw`);

    // When <actor> sends "<event>"
    const res =
      event === "withdraw"
        ? await withdrawAsk(w.srv, leases[actor as "devtool" | "docs"], id)
        : event === "answer"
          ? await answerAsk(w.owner, id, { choice: "recommended" })
          : event === "answer-other"
            ? await answerAsk(w.owner, id, { choice: "alternative", index: 1 })
            : event === "snooze"
              ? await snoozeAsk(w.owner, id, { preset: "1h" })
              : await markAsk(w.owner, id, event as "dismiss" | "undismiss");

    // Then the server answers <status>
    expect([`${from} ${actor} ${event}`, res.status]).toEqual([`${from} ${actor} ${event}`, status]);

    // And the ask is in state "<to>"
    const now = await expectState(w.owner, id);
    expect([`${from} ${actor} ${event}`, to === "closed" ? now.split(" ")[0] : now]).toEqual([`${from} ${actor} ${event}`, to]);
  }
});

scenario("Fifty racing answers produce one decision", { tag: ["@api", "@invariant"] }, async ({ server, dataDir }) => {
  // Given an open ask of "devtool"
  const { w, conv, devtool } = await askWorld(server, { plaintext: true });
  const id = await agentAsks(w.srv, devtool.lease, conv);
  const unreadBefore = await unreadOf(w.owner, conv);

  // When 50 answer requests with 50 different custom texts arrive at the same time
  const results = await Promise.all(Array.from({ length: 50 }, (_, i) => answerAsk(w.owner, id, { choice: "custom", text: `answer number ${i + 1}` })));

  // Then exactly 1 answers 200
  const won = results.filter((r) => r.status === 200);
  expect(won.length).toBe(1);
  const winner = won[0]!.json().ask.chosen.text as string;

  // And 49 answer 409 with the winning text
  const lost = results.filter((r) => r.status === 409);
  expect(lost.length).toBe(49);
  expect(lost.every((r) => r.json().ask.chosen.text === winner), "every loser carries the winning text").toBe(true);

  // And re-sending the winning text as the same owner answers 200 and writes nothing
  const before = answerMessages(dataDir, id).length;
  const again = await answerAsk(w.owner, id, { choice: "custom", text: winner });
  expect([again.status, answerMessages(dataDir, id).length, before]).toEqual([200, 1, 1]);

  // And conversation 41 shows exactly 1 answer message
  expect(answerMessages(dataDir, id).map((m) => m.body)).toEqual([winner]);

  // And the owner's unread state of conversation 41 is unchanged
  expect(await unreadOf(w.owner, conv)).toBe(unreadBefore);
});

scenario("Undismiss after the asker left is refused", { tag: ["@api"] }, async ({ server }) => {
  // Given a dismissed ask of "devtool"
  const { w, conv, devtool } = await askWorld(server);
  const id = await agentAsks(w.srv, devtool.lease, conv);
  must(await markAsk(w.owner, id, "dismiss"), "dismiss");

  // And "devtool" left conversation 41
  must(await send(w.srv.target, "POST", `/api/conversations/${conv}/leave`, { json: {}, ...bearer(devtool.lease) }), "devtool leaves");

  // When the owner undismisses the ask
  const res = await markAsk(w.owner, id, "undismiss");

  // Then the server answers 409 with the code "asker_gone"
  expect([res.status, res.json().error?.code]).toEqual([409, "asker_gone"]);
});

scenario("Undismiss respects the open-ask cap", { tag: ["@api"] }, async ({ server, testApi }) => {
  // Given a dismissed ask of "devtool" and 20 other open asks of "devtool"
  const { w, conv, devtool } = await askWorld(server);
  const id = await agentAsks(w.srv, devtool.lease, conv, { question: "Dismissed question?" });
  must(await markAsk(w.owner, id, "dismiss"), "dismiss");
  const others = [];
  for (let i = 0; i < 3; i++) others.push(await createConversation(w.owner, { title: `Topic ${i}`, participants: ["devtool"] }));
  const homes = [conv, ...others];
  for (let i = 0; i < 20; i++) {
    if (i === 10) await testApi(w.srv).advanceClock(25_000); // the post budget of an agent (20 in a burst) refills
    await agentAsks(w.srv, devtool.lease, homes[i % homes.length]!, { question: `Question ${i + 1}?` });
  }

  // When the owner undismisses the ask
  const res = await markAsk(w.owner, id, "undismiss");

  // Then the server answers 409 with the code "ask_cap"
  expect([res.status, res.json().error?.code]).toEqual([409, "ask_cap"]);
});

scenario("A repeated ack is a no-op", { tag: ["@cli"] }, async ({ server }) => {
  // Given "devtool" acked the answer to its ask
  const { w, conv, devtool } = await askWorld(server);
  const id = await agentAsks(w.srv, devtool.lease, conv);
  must(await answerAsk(w.owner, id, { choice: "recommended" }), "answer");
  const [item] = (await inboxItems(w.box, devtool.sid, ["--claim", "5", "--wait", "0"])).filter((i) => i.reason === "ask_resolved");
  const ref = `${item!.id}:${item!.claim_token}`;
  expect((await convoz(w.box, devtool.sid, ["ack", ref])).code).toBe(0);

  // When "devtool" acks the same item again with the same claim token
  const repeat = await convoz(w.box, devtool.sid, ["ack", ref]);

  // Then the CLI exits 0
  expect({ code: repeat.code, stderr: repeat.stderr }).toEqual({ code: 0, stderr: "" });
});

scenario("A choice the ask did not offer is refused", { tag: ["@api"] }, async ({ server }) => {
  // Given an open ask of "devtool" with 1 alternative
  const { w, conv, devtool } = await askWorld(server);
  const id = await agentAsks(w.srv, devtool.lease, conv);

  // When the owner answers with alternative 3
  const res = await answerAsk(w.owner, id, { choice: "alternative", index: 3 });

  // Then the server answers 400
  expect(res.status).toBe(400);

  // And conversation 41 shows no answer message
  const bodies = (await pageOf(w.owner, conv, "limit=100")).map((m) => m.body);
  expect(bodies.filter((b) => b === "Hold it" || b === "Merge it")).toEqual([]);
  expect((await askOf(w.owner, id)).state).toBe("open");
});

scenario("There is no answer path for agents or the CLI in v1", { tag: ["@api", "@cli"] }, async ({ server }) => {
  // Given "devtool" and "docs" are active participants of conversation 41 "Ship search filters"
  const { w, conv, devtool } = await askWorld(server);
  const id = await agentAsks(w.srv, devtool.lease, conv);

  // When the "devtool" lease calls POST /api/asks/:id/answer on an open ask
  const res = await send(w.srv.target, "POST", `/api/asks/${id}/answer`, { json: { choice: "recommended" }, ...bearer(devtool.lease) });

  // Then the server answers 403
  expect(res.status).toBe(403);

  // And "convoz --help" lists no answer command
  const help = await w.box.run(["--help"]);
  const text = `${help.stdout}${help.stderr}`;
  expect(text).toContain("convoz ask ");
  expect(text).not.toMatch(/convoz answer\b/);
  expect((await askOf(w.owner, id)).state).toBe("open");
});

scenario("The ask history is append-only and names every actor", { tag: ["@api"] }, async ({ server, dataDir }) => {
  // Given an ask of "devtool" that the owner dismissed and undismissed, and that "devtool" then withdrew
  const { w, conv, devtool } = await askWorld(server, { plaintext: true });
  const id = await agentAsks(w.srv, devtool.lease, conv);
  must(await markAsk(w.owner, id, "dismiss"), "dismiss");
  must(await markAsk(w.owner, id, "undismiss"), "undismiss");
  must(await withdrawAsk(w.srv, devtool.lease, id), "withdraw");

  // When a client reads GET /api/asks/:id
  const ask = await askOf(w.owner, id);

  // Then the history has the rows create by "devtool", dismiss by the owner, undismiss by the owner and withdraw by "devtool", in version order
  expect((ask.history ?? []).map((h) => [h.version, h.event, h.by?.handle])).toEqual([
    [1, "create", "devtool"],
    [2, "dismiss", "drew"],
    [3, "undismiss", "drew"],
    [4, "withdraw", "devtool"],
  ]);

  // And no route can change or delete a history row
  const routes = must(await send(w.srv.target, "GET", "/__test/routes"), "list routes").json().routes as { method: string; pattern: string }[];
  expect(routes.filter((r) => /history|transitions/.test(r.pattern) && r.method !== "GET")).toEqual([]);
  const db = plainDb(dataDir);
  try {
    expect(() => db.prepare("UPDATE ask_transitions SET event = 'answer' WHERE message_id = ? AND version = 2").run(id)).toThrow(/append-only/);
  } finally {
    db.close();
  }
});

scenario("Snoozing does not change the ask version", { tag: ["@api"] }, async ({ server }) => {
  // Given an open ask of "devtool" at version 1
  const { w, conv, devtool } = await askWorld(server);
  const id = await agentAsks(w.srv, devtool.lease, conv);
  expect((await askOf(w.owner, id)).version).toBe(1);

  // When the owner snoozes it until tomorrow 09:00
  const snoozed = await snoozeAsk(w.owner, id, { preset: "tomorrow", tz: "UTC" });
  expect(snoozed.status).toBe(200);

  // Then GET /api/now shows the ask under snoozed with version 1
  const now = await nowOf(w.owner);
  expect(now.snoozed.map((a) => [a.id, a.version])).toEqual([[id, 1]]);

  // And an answer sent with if_version 1 answers 200
  const res = await answerAsk(w.owner, id, { choice: "recommended" }, { if_version: 1 });
  expect(res.status).toBe(200);
});
