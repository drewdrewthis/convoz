import type { Locator, Page } from "@playwright/test";
import { McpClient } from "../lib/agent-wp7.ts";
import { convoz, createConversation, inboxItems, messagesOf } from "../lib/chat.ts";
import {
  ACTION, CONSIDERED, GET_CONFIDENT_FIRST, RISK, UNDO,
  agentAsks, agentAsksPermission, answerAsk, askBody, askCard, askOf, askWorld, expectInOrder, nowOf, notThisBox, openNow, patchAsk, permissionArgs,
  permissionBody, postAsk, type AskView,
} from "../lib/asks.ts";
import { box } from "../lib/mobile.ts";
import { openRail, rail } from "../lib/rail-wp9.ts";
import { must } from "../lib/owner.ts";
import { decrypt, pushWorld, received } from "../lib/push-wp14.ts";
import { clientId } from "../lib/machines.ts";
import { expect, scenario } from "../lib/scenario.ts";
import { browserWorld } from "../lib/wp3.ts";

/*
 * PERMISSION ASKS: the bindings of the "An ask is a permission request" rules of specs/features/asks.feature and specs/contracts/asks.feature.
 * An agent asks with `convoz ask --action A --risk R (--undo U | --one-way) --considered C [--considered C2 ...] --confidence N <conv>`; over the API
 * `POST /api/asks` takes `permission: {action, risk, undo | one_way, considered[1-3], confidence}`. The card is an article named by the action.
 * Page contract (role and name only): buttons "Go" and "Not this"; "Not this" opens a textbox "Why not? @<agent> reads this." and a "Send" button;
 * terms "I will", "Risk", "Undo", "Considered, and why worse"; on a phone the button "Considered 2 other ways"; an answered card has a "Details" button.
 */

type Fx = Parameters<typeof browserWorld>[0];

/** A browser world with one permission ask of "devtool" in "Ship search filters". */
async function browserAsk({ server, page, context }: Fx, over: Record<string, unknown> = {}) {
  const w = await browserWorld({ server, page, context }, { agents: ["devtool", "docs"], live: ["devtool"] });
  const conv = await createConversation(w.owner, { title: "Ship search filters", participants: ["devtool", "docs"] });
  const id = await agentAsksPermission(w.srv, w.sessions.devtool!.lease, conv, over);
  return { w, conv, id };
}

const ONE_WAY = { undo: undefined, one_way: true };

/** What the asking agent reads in its inbox once the owner answered. */
async function agentAnswer(w: Awaited<ReturnType<typeof browserAsk>>["w"], id: number): Promise<string | undefined> {
  const items = (await inboxItems(w.box, w.sessions.devtool!.sid, ["--peek"])) as unknown as { reason: string; message: { id: number; ask?: { answer?: string } } }[];
  return items.find((i) => i.reason === "ask_resolved" && i.message.id === id)?.message.ask?.answer;
}

/** The phone shows the considered ways folded; open the fold so a check that reads them works on both. */
async function openConsidered(card: Locator): Promise<void> {
  const fold = card.getByRole("button", { name: /^Considered \d other ways?$/ });
  await expect(card.getByRole("button", { name: "Go", exact: true })).toBeVisible(); // the card is drawn, so count() sees a fold that is there
  if (await fold.count()) await fold.click();
}

/** Open conversation `conv` on a wide screen and turn the rail to Now. */
async function railNow(page: Page, w: Awaited<ReturnType<typeof browserAsk>>["w"], conv: number): Promise<void> {
  await openRail(page, w.srv, `/chats/${conv}`);
  const now = rail(page).getByRole("button", { name: /^Now\b/ });
  await now.click();
  await expect(now).toHaveAttribute("aria-pressed", "true");
}

// ---- features/asks.feature ------------------------------------------------------------------------------------

scenario("A permission ask reads as a short request on the Now card", { tag: ["@browser"] }, async ({ server, page, context }, info) => {
  info.setTimeout(90_000);
  const { w } = await browserAsk({ server, page, context });
  await openNow(page, w.srv);
  const card = askCard(page, ACTION);
  await expect(card).toBeVisible();
  await openConsidered(card);

  // Then the card shows, in order, the byline, "I will" and the action, "Risk", "Undo", "Considered, and why worse" with its lines, Go, Not this, I have questions and Snooze
  await expectInOrder(card, ["@devtool · Ship search filters", "I will", ACTION, "Risk", RISK, "Undo", UNDO, "Considered, and why worse", CONSIDERED[0]!, CONSIDERED[1]!, "Go", "Not this", "I have questions", "Snooze"]);
  for (const name of ["Go", "Not this", "I have questions", "Snooze", "Dismiss"]) await expect(card.getByRole("button", { name, exact: true }), name).toBeVisible();
  await expect(card.getByRole("link", { name: "Open", exact: true })).toBeVisible();

  // And it shows no "Quick reply" and no confidence
  await expect(card.getByRole("button", { name: "Quick reply" })).toHaveCount(0);
  expect(await card.innerText()).not.toMatch(/confiden|\d+\s?%/i);
});

scenario("Go on a permission card answers Go", { tag: ["@browser"] }, async ({ server, page, context }, info) => {
  info.setTimeout(90_000);
  const { w, conv, id } = await browserAsk({ server, page, context });
  await page.goto(`${w.srv.origin}/chats/${conv}`);
  const card = askCard(page, ACTION);
  await card.getByRole("button", { name: "Go", exact: true }).click();
  await expect(card.getByText("You said Go")).toBeVisible();
  expect(await agentAnswer(w, id)).toBe("Go");
});

scenario("Not this on a permission card needs a reason and sends it to the agent", { tag: ["@browser"] }, async ({ server, page, context }, info) => {
  info.setTimeout(90_000);
  const { w, conv, id } = await browserAsk({ server, page, context });
  await page.goto(`${w.srv.origin}/chats/${conv}`);
  const card = askCard(page, ACTION);

  // When the owner taps "Not this"
  await card.getByRole("button", { name: "Not this", exact: true }).click();

  // Then a box "Why not? @devtool reads this." opens and Send is disabled while it is empty
  await expect(notThisBox(card)).toBeVisible();
  await expect(card.getByRole("button", { name: "Send", exact: true })).toBeDisabled();

  // When the owner writes a reason and sends it
  await notThisBox(card).fill("Wait for PR 412");
  await card.getByRole("button", { name: "Send", exact: true }).click();

  // Then the card shows "Not this · Wait for PR 412" and the agent reads "Not this: Wait for PR 412"
  await expect(card.getByText("Not this · Wait for PR 412")).toBeVisible();
  expect(await agentAnswer(w, id)).toBe("Not this: Wait for PR 412");
});

scenario("G and Enter say Go and N opens Not this", { tag: ["@browser"] }, async ({ server, page, context }, info) => {
  info.setTimeout(90_000);
  const { w, conv, id } = await browserAsk({ server, page, context });
  const second = await agentAsksPermission(w.srv, w.sessions.devtool!.lease, conv, { action: "Deploy the docs site" });
  await openNow(page, w.srv);

  // When the owner presses N on the first card
  const card = askCard(page, ACTION);
  await card.focus();
  await page.keyboard.press("n");
  await expect(notThisBox(card)).toBeVisible();
  await page.keyboard.press("Escape");

  // When the owner presses G, and Enter on the other card, each says Go
  await card.focus();
  await page.keyboard.press("g");
  await expect(card).toHaveCount(0);
  const other = askCard(page, "Deploy the docs site");
  await other.focus();
  await page.keyboard.press("Enter");
  await expect(other).toHaveCount(0);
  expect([(await askOf(w.owner, id)).answer, (await askOf(w.owner, second)).answer]).toEqual(["Go", "Go"]);
});

scenario("Enter does nothing on a one-way permission ask", { tag: ["@browser"] }, async ({ server, page, context }, info) => {
  info.setTimeout(90_000);
  const { w, id } = await browserAsk({ server, page, context }, ONE_WAY);
  await openNow(page, w.srv);
  const card = askCard(page, ACTION);
  await expect(card.getByText("None. This is one-way.")).toBeVisible();

  // When the owner presses Enter on the card
  await card.focus();
  await page.keyboard.press("Enter");
  await page.waitForTimeout(500);

  // Then the ask is still open, and G and a click on Go still say Go
  expect((await askOf(w.owner, id)).state).toBe("open");
  await page.keyboard.press("g");
  await expect(card).toHaveCount(0);
  expect((await askOf(w.owner, id)).answer).toBe("Go");
});

scenario("Typing in the Not this box is not a shortcut", { tag: ["@browser"] }, async ({ server, page, context }, info) => {
  info.setTimeout(90_000);
  const { w, id } = await browserAsk({ server, page, context });
  await openNow(page, w.srv);
  const card = askCard(page, ACTION);
  await card.getByRole("button", { name: "Not this", exact: true }).click();

  // When the owner types "go now" in the box (Enter there sends the reason, as in any form)
  await notThisBox(card).pressSequentially("go now");
  await page.waitForTimeout(500);

  // Then the box holds "go now" and the ask is still open
  await expect(notThisBox(card)).toHaveValue(/go now/);
  expect((await askOf(w.owner, id)).state).toBe("open");
});

scenario("A permission ask in the conversation says Needs your OK", { tag: ["@browser"] }, async ({ server, page, context }, info) => {
  info.setTimeout(90_000);
  const { w, conv } = await browserAsk({ server, page, context });
  await page.goto(`${w.srv.origin}/chats/${conv}`);
  const card = askCard(page, ACTION);
  await openConsidered(card);
  await expect(card.getByText("Needs your OK", { exact: true })).toBeVisible();
  for (const text of ["I will", ACTION, "Risk", RISK, "Undo", UNDO, "Considered, and why worse", CONSIDERED[0]!]) await expect(card.getByText(text, { exact: false }).first(), text).toBeVisible();
  for (const name of ["Go", "Not this"]) await expect(card.getByRole("button", { name, exact: true }), name).toBeVisible();
  // the author is above the card, so the card has no byline of its own
  expect(await card.innerText()).not.toContain("@devtool · Ship search filters");
});

scenario("The sidebar shows a short permission card", { tag: ["@browser"] }, async ({ server, page, context }, info) => {
  info.setTimeout(90_000);
  const { w, conv } = await browserAsk({ server, page, context });
  const home = await createConversation(w.owner, { title: "Release train", participants: ["devtool"] });
  await railNow(page, w, home);
  const card = rail(page).getByRole("article", { name: ACTION });
  await expectInOrder(card, ["@devtool", "I will", ACTION, "Risk", RISK, "Undo", UNDO, "Go", "Open"]);
  await expect(card.getByText(CONSIDERED[0]!)).toHaveCount(0);
  await expect(card.getByRole("link", { name: "Open", exact: true })).toHaveAttribute("href", `/chats/${conv}`);
});

scenario("The sidebar shows Review for a one-way permission ask", { tag: ["@browser"] }, async ({ server, page, context }, info) => {
  info.setTimeout(90_000);
  const { w, conv } = await browserAsk({ server, page, context }, ONE_WAY);
  const home = await createConversation(w.owner, { title: "Release train", participants: ["devtool"] });
  await railNow(page, w, home);
  const card = rail(page).getByRole("article", { name: ACTION });
  await expect(card.getByRole("link", { name: "Review", exact: true })).toHaveAttribute("href", `/chats/${conv}`);
  await expect(card.getByRole("button", { name: "Go", exact: true })).toHaveCount(0);
});

scenario("On a phone the considered ways fold and Go and Not this stack", { tag: ["@browser", "@phone"] }, async ({ server, page, context }, info) => {
  info.setTimeout(90_000);
  const { w } = await browserAsk({ server, page, context });
  await openNow(page, w.srv);
  const card = askCard(page, ACTION);

  // Then the considered ways are folded behind "Considered 2 other ways" and open on a tap
  await expect(card.getByText(CONSIDERED[0]!)).toBeHidden();
  await card.getByRole("button", { name: "Considered 2 other ways", exact: true }).click();
  await expect(card.getByText(CONSIDERED[0]!)).toBeVisible();

  // And Go sits above Not this, both as wide as the card
  const go = await box(card.getByRole("button", { name: "Go", exact: true }));
  const not = await box(card.getByRole("button", { name: "Not this", exact: true }));
  expect(not.y).toBeGreaterThan(go.y);
  expect(not.x).toBeCloseTo(go.x, 0);
});

scenario("History says how sure the agent said it was", { tag: ["@browser"] }, async ({ server, page, context }, info) => {
  info.setTimeout(90_000);
  const { w, conv } = await browserAsk({ server, page, context }, { confidence: 90 });
  await page.goto(`${w.srv.origin}/chats/${conv}`);
  const card = askCard(page, ACTION);
  await card.getByRole("button", { name: "Ask options" }).click();
  await page.getByRole("menuitem", { name: "History" }).click();
  const rows = await card.getByRole("list", { name: "History" }).getByRole("listitem").allInnerTexts();
  expect(rows.some((r) => /^Asked by .*@devtool · said 90% sure$/.test(r.trim()))).toBe(true);
  expect(await card.innerText()).not.toMatch(/confiden/i);
});

scenario("An ask from an old agent still shows the decision card", { tag: ["@browser"] }, async ({ server, page, context }, info) => {
  info.setTimeout(90_000);
  const w = await browserWorld({ server, page, context }, { agents: ["devtool", "docs"], live: ["devtool"] });
  const conv = await createConversation(w.owner, { title: "Ship search filters", participants: ["devtool", "docs"] });
  // Given an old CLI asked with the old body: question, recommended, alternatives and the owner's call, no permission object
  const id = await agentAsks(w.srv, w.sessions.devtool!.lease, conv, {});
  // Then the API reads it as a decision ask, and Now shows the old card
  expect((await askOf(w.owner, id)).kind).toBe("decision");
  await openNow(page, w.srv);
  const card = askCard(page);
  await expect(card.getByRole("button", { name: "Merge it", exact: true })).toBeVisible();
  await expect(card.getByText("Your call · taste: Both names read fine; it is your voice", { exact: true })).toBeVisible();
  await expect(card.getByRole("button", { name: "Not this", exact: true })).toHaveCount(0);
  await expect(card.getByText("I will", { exact: true })).toHaveCount(0);
});

scenario("An answered permission card hides risk, undo and considered behind Details", { tag: ["@browser"] }, async ({ server, page, context }, info) => {
  info.setTimeout(90_000);
  const { w, conv, id } = await browserAsk({ server, page, context });
  must(await answerAsk(w.owner, id, { choice: "recommended" }), "go", 200);
  await page.goto(`${w.srv.origin}/chats/${conv}`);
  const card = askCard(page, ACTION);
  await expect(card.getByText("You said Go")).toBeVisible();
  for (const text of [RISK, UNDO, CONSIDERED[0]!]) await expect(card.getByText(text), text).toBeHidden();
  await card.getByRole("button", { name: "Details", exact: true }).click();
  for (const text of [RISK, UNDO, CONSIDERED[0]!]) await expect(card.getByText(text), text).toBeVisible();
});

// ---- contracts/asks.feature -----------------------------------------------------------------------------------

scenario("A permission ask opens with its parts and is told apart from a decision and a draft", { tag: ["@api"] }, async ({ server }) => {
  const { w, conv, devtool } = await askWorld(server);
  // When "devtool" posts a permission ask with no question and no owners_call
  const res = await postAsk(w.srv, devtool.lease, permissionBody(conv));
  expect(res.status).toBe(201);
  const ask = (await askOf(w.owner, (res.json().ask as AskView).id)) as AskView;

  // Then the ask is open, of kind "permission", echoes its parts, has the action as its question and offers Go and Not this
  expect([ask.state, ask.kind, ask.question, ask.options.map((o) => o.label)]).toEqual(["open", "permission", ACTION, ["Go", "Not this"]]);
  expect(ask.permission).toEqual({ action: ACTION, risk: RISK, undo: UNDO, considered: CONSIDERED, confidence: 90 });

  // And an old-shape ask reads as kind "decision" with no permission object, and a draft ask as kind "draft"
  const legacy = await askOf(w.owner, await agentAsks(w.srv, devtool.lease, conv));
  expect([legacy.kind, legacy.permission]).toEqual(["decision", undefined]);
  const draft = must(await postAsk(w.srv, devtool.lease, { conversation_id: conv, client_id: clientId(), question: "Send this?", draft: { text: "Yes." } }), "draft ask", 201).json().ask as AskView;
  expect((await askOf(w.owner, draft.id)).kind).toBe("draft");
});

scenario("A permission ask that is incomplete or over a limit is refused naming the field", { tag: ["@api"] }, async ({ server }) => {
  const { w, conv, devtool } = await askWorld(server);
  const x = (n: number) => "é".repeat(n);
  const rows: [string, Record<string, unknown>, string][] = [
    ["an action of 101 characters", { action: x(101) }, "action"],
    ["a risk of 141 characters", { risk: x(141) }, "risk"],
    ["an undo of 81 characters", { undo: x(81) }, "undo"],
    ["a considered line of 121 characters", { considered: [x(121)] }, "considered"],
    ["an empty action", { action: "" }, "action"],
    ["a whitespace-only risk", { risk: "   " }, "risk"],
    ["undo and one_way together", { one_way: true }, "undo"],
    ["neither undo nor one_way", { undo: undefined }, "undo"],
    ["no considered", { considered: [] }, "considered"],
    ["4 considered", { considered: ["a", "b", "c", "d"] }, "considered"],
    ["a confidence of -1", { confidence: -1 }, "confidence"],
    ["a confidence of 101", { confidence: 101 }, "confidence"],
    ["a confidence of 80.5", { confidence: 80.5 }, "confidence"],
  ];
  for (const [problem, over, field] of rows) {
    // When "devtool" posts a permission ask with <problem>
    const res = await postAsk(w.srv, devtool.lease, permissionBody(conv, over));
    // Then the server answers 400 naming "<field>"
    expect([problem, res.status, res.status === 400 ? res.json().error.field : res.text]).toEqual([problem, 400, field]);
  }
  // And a permission together with a draft is refused
  const both = await postAsk(w.srv, devtool.lease, permissionBody(conv, {}, { draft: { text: "Yes." } }));
  expect([both.status, both.json().error.field]).toEqual([400, "permission"]);
  // And an action of exactly 100 characters is accepted, and no refused ask opened
  expect((await postAsk(w.srv, devtool.lease, permissionBody(conv, { action: x(100) }))).status).toBe(201);
  expect((await nowOf(w.owner)).asks).toHaveLength(1);
  // And the message names the limit
  const long = await postAsk(w.srv, devtool.lease, permissionBody(conv, { action: x(101) }));
  expect(long.json().error.message).toBe("Shorten: action has at most 100 characters");
});

scenario("A confidence under 80 is refused and 80 is accepted", { tag: ["@api"] }, async ({ server }) => {
  const { w, conv, devtool } = await askWorld(server);
  for (const confidence of [79, 0, undefined]) {
    const res = await postAsk(w.srv, devtool.lease, permissionBody(conv, { confidence }));
    expect([confidence, res.status, res.json().error.message]).toEqual([confidence, 400, GET_CONFIDENT_FIRST]);
  }
  expect((await postAsk(w.srv, devtool.lease, permissionBody(conv, { confidence: 80 }))).status).toBe(201);
});

scenario("Go and Not this answer a permission ask", { tag: ["@api"] }, async ({ server }) => {
  const { w, conv, devtool } = await askWorld(server);
  const go = await agentAsksPermission(w.srv, devtool.lease, conv);
  const not = await agentAsksPermission(w.srv, devtool.lease, conv, { action: "Deploy the docs site" });

  // When the owner answers the first with Go and the second with Not this and a reason
  must(await answerAsk(w.owner, go, { choice: "recommended" }), "go", 200);
  must(await answerAsk(w.owner, not, { choice: "alternative", index: 1 }, { text: "Wait for PR 412" }), "not this", 200);

  // Then the answers read "Go" and "Not this: Wait for PR 412" for the owner and in the conversation
  expect((await askOf(w.owner, go)).answer).toBe("Go");
  expect((await askOf(w.owner, not)).answer).toBe("Not this: Wait for PR 412");
  expect((await messagesOf(w.owner, conv)).map((m) => m.body)).toEqual(expect.arrayContaining(["Go", "Not this: Wait for PR 412"]));

  // And the agent reads the same answers in its inbox, and a second, different answer is refused
  const items = (await inboxItems(w.box, devtool.sid, ["--peek"])) as unknown as { message: { id: number; ask?: { answer?: string } } }[];
  expect(items.map((i) => i.message.ask?.answer).sort()).toEqual(["Go", "Not this: Wait for PR 412"]);
  expect((await answerAsk(w.owner, go, { choice: "alternative", index: 1 }, { text: "No" })).status).toBe(409);
});

scenario("A Not this answer without a good reason is refused", { tag: ["@api"] }, async ({ server }) => {
  const { w, conv, devtool } = await askWorld(server);
  const id = await agentAsksPermission(w.srv, devtool.lease, conv);
  const rows: [string, { choice: "alternative"; index: number } | { choice: "recommended" }, Record<string, unknown>][] = [
    ["no text", { choice: "alternative", index: 1 }, {}],
    ["whitespace-only text", { choice: "alternative", index: 1 }, { text: "   " }],
    ["text of 4001 characters", { choice: "alternative", index: 1 }, { text: "x".repeat(4001) }],
    ["Go with text", { choice: "recommended" }, { text: "because" }],
  ];
  for (const [problem, choice, extra] of rows) {
    const res = await answerAsk(w.owner, id, choice, extra);
    expect([problem, res.status, res.json().error.field]).toEqual([problem, 400, "text"]);
  }
  expect((await askOf(w.owner, id)).state).toBe("open");
});

scenario("The agent rewrites the parts of its permission ask", { tag: ["@api"] }, async ({ server }) => {
  const { w, conv, devtool } = await askWorld(server);
  const id = await agentAsksPermission(w.srv, devtool.lease, conv);
  const parts = { action: ACTION, risk: RISK, undo: UNDO, considered: CONSIDERED };

  // When "devtool" updates the action and the considered lines
  const res = await patchAsk(w.srv, devtool.lease, id, { permission: { ...parts, action: "Merge PR 415 after the nightly", considered: ["Hold: costs a day"] } });
  expect(res.status).toBe(200);

  // Then the ask shows the new parts and "changed" names exactly those two
  const ask = await askOf(w.owner, id);
  expect([ask.question, ask.permission?.action, ask.permission?.considered, ask.changed]).toEqual(["Merge PR 415 after the nightly", "Merge PR 415 after the nightly", ["Hold: costs a day"], "action, considered"]);

  // When "devtool" makes it one-way, undo goes
  must(await patchAsk(w.srv, devtool.lease, id, { permission: { ...parts, undo: undefined, one_way: true } }), "one way", 200);
  const oneWay = (await askOf(w.owner, id)).permission;
  expect([oneWay?.one_way, oneWay?.undo]).toEqual([true, undefined]);
});

scenario("A permission update that changes the wrong thing is refused", { tag: ["@api"] }, async ({ server }) => {
  const { w, conv, devtool } = await askWorld(server);
  const id = await agentAsksPermission(w.srv, devtool.lease, conv);
  const parts = { action: ACTION, risk: RISK, undo: UNDO, considered: CONSIDERED };
  for (const [problem, body, field] of [
    ["undo and one_way together", { permission: { ...parts, one_way: true } }, "undo"],
    ["a new confidence", { permission: { ...parts, confidence: 95 } }, "confidence"],
    ["an action over 100 characters", { permission: { ...parts, action: "x".repeat(101) } }, "action"],
  ] as const) {
    const res = await patchAsk(w.srv, devtool.lease, id, body);
    expect([problem, res.status, res.json().error.field]).toEqual([problem, 400, field]);
  }
  // permission fields on a decision ask and on a draft ask are refused
  const legacy = await agentAsks(w.srv, devtool.lease, conv);
  const draft = must(await postAsk(w.srv, devtool.lease, { conversation_id: conv, client_id: clientId(), question: "Send this?", draft: { text: "Yes." } }), "draft", 201).json().ask.id as number;
  for (const target of [legacy, draft]) expect((await patchAsk(w.srv, devtool.lease, target, { permission: parts })).status, `ask ${target}`).toBe(400);
});

scenario("The CLI asks for permission and refuses a low confidence", { tag: ["@cli"] }, async ({ server }) => {
  const { w, conv, devtool } = await askWorld(server);

  // When "devtool" runs "convoz ask" with the permission flags and --confidence 79
  const low = await convoz(w.box, devtool.sid, permissionArgs(conv, { confidence: "79" }));
  // Then the command exits 2 and both streams carry the get-confident text
  expect(low.code).toBe(2);
  expect(low.stdout).toContain(GET_CONFIDENT_FIRST);
  expect(low.stderr).toContain(GET_CONFIDENT_FIRST);
  expect((await nowOf(w.owner)).asks).toEqual([]);

  // When it runs again with --confidence 80
  const ran = await convoz(w.box, devtool.sid, ["ask", "--json", ...permissionArgs(conv, { confidence: "80" }).slice(1)]);
  // Then the command succeeds, prints the id and the owner sees a permission ask
  expect({ code: ran.code, stderr: ran.stderr }).toEqual({ code: 0, stderr: "" });
  const [card] = (await nowOf(w.owner)).asks;
  expect([JSON.parse(ran.stdout).id, card?.kind, card?.permission?.considered]).toEqual([card?.id, "permission", CONSIDERED]);

  // And with --one-way instead of --undo the ask is one-way
  expect((await convoz(w.box, devtool.sid, permissionArgs(conv, { oneWay: true, action: "Delete the old bucket" }))).code).toBe(0);
  expect((await nowOf(w.owner)).asks.find((a) => a.question === "Delete the old bucket")?.permission?.one_way).toBe(true);
});

scenario("Old ask flags still make a decision ask and mixing them with the new flags is refused", { tag: ["@cli"] }, async ({ server }) => {
  const { w, conv, devtool } = await askWorld(server);
  const old = ["ask", "--question", "Ship it?", "--recommend", "Ship", "--why", "Green", "--alt", "Wait", "--alt-why", "One more check", "--owners-call", "taste", "--owners-call-why", "Your voice", String(conv)];

  // When "devtool" asks with the old flags
  const ran = await convoz(w.box, devtool.sid, old);
  // Then the command succeeds, the ask is a decision and stderr has the one hint line
  expect(ran.code).toBe(0);
  expect(ran.stderr.trim()).toBe("hint: use --action ... for a permission ask");
  expect((await nowOf(w.owner)).asks.map((a) => a.kind)).toEqual(["decision"]);

  // When it mixes an old option flag with --action
  const mixed = await convoz(w.box, devtool.sid, [...permissionArgs(conv).slice(0, -1), "--recommend", "Ship", String(conv)]);
  // Then the command exits 2 and no new ask opens
  expect(mixed.code).toBe(2);
  expect((await nowOf(w.owner)).asks).toHaveLength(1);
});

scenario("The ask tool takes a permission request and refuses a low confidence", { tag: ["@mcp"] }, async ({ server }) => {
  const { w, conv } = await askWorld(server);
  const mcp = await McpClient.start(w.box, "devtool", "claude-TESTONLY-mcp-permission");
  try {
    const args = { conversation: conv, action: ACTION, risk: RISK, undo: UNDO, considered: CONSIDERED };
    // When the "ask" tool is called with confidence 79
    const low = await mcp.tool("ask", { ...args, confidence: 79 });
    // Then it is refused with the get-confident text and nothing opens
    expect(low.isError).toBe(true);
    expect(JSON.stringify(low)).toContain(GET_CONFIDENT_FIRST);
    expect((await nowOf(w.owner)).asks).toEqual([]);

    // When it is called with confidence 80, the owner sees a permission ask with those parts
    const ok = await mcp.tool("ask", { ...args, confidence: 80 });
    expect(ok.isError ?? false).toBe(false);
    const [card] = (await nowOf(w.owner)).asks;
    expect([card?.kind, card?.permission]).toEqual(["permission", { action: ACTION, risk: RISK, undo: UNDO, considered: CONSIDERED, confidence: 80 }]);
  } finally {
    mcp.end();
  }
});

scenario("A permission ask pushes what the agent will do", { tag: ["@api"] }, async ({ server, dataDir, testApi }, info) => {
  info.setTimeout(60_000);
  const w = await pushWorld(server, dataDir);
  const before = (await received(w.srv)).length;
  // When "devtool" asks for permission to "Merge PR 415 into main"
  must(await postAsk(w.srv, w.dev, permissionBody(w.conv)), "permission ask", 201);
  await expect.poll(async () => (await received(w.srv)).length, { timeout: 15_000 }).toBeGreaterThan(before);
  // Then the push body reads "@devtool will: Merge PR 415 into main"
  expect(decrypt(w.sub, (await received(w.srv))[before]!).body).toBe(`@devtool will: ${ACTION}`);

  // And an old-shape ask pushes its question, as before
  await testApi(w.srv).advanceClock(2 * 60_000); // pushes within a minute of each other would read "2 new"
  const legacyBefore = (await received(w.srv)).length;
  must(await postAsk(w.srv, w.dev, askBody(w.conv, { question: "Merge #415 on its own?" })), "legacy ask", 201);
  await expect.poll(async () => (await received(w.srv)).length, { timeout: 15_000 }).toBeGreaterThan(legacyBefore);
  expect(decrypt(w.sub, (await received(w.srv))[legacyBefore]!).body).toBe("Ask: Merge #415 on its own?");
});
