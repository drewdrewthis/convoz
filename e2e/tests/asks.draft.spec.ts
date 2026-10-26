import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Page } from "@playwright/test";
import { McpClient } from "../lib/agent-wp7.ts";
import { convoz, createConversation, inboxItems, messagesOf, startWatch, watchLines } from "../lib/chat.ts";
import { answerAsk, askBody, askCard, askOf, askWorld, nowOf, openNow, postAsk, type AskView } from "../lib/asks.ts";
import { appCard, validApp } from "../lib/apps-wp11.ts";
import { expect, scenario } from "../lib/scenario.ts";
import { must } from "../lib/owner.ts";
import { browserWorld, type World } from "../lib/wp3.ts";
import type { CliMachine } from "../lib/cli.ts";

/*
 * DRAFT ASKS: the bindings of the scenarios added to specs/features/asks.feature and cli-mcp.feature for the "review a draft" ask and
 * the app on an ask card. An agent asks with `convoz ask --draft TEXT [--original TEXT] [--original-from LINE] --question Q <conv>`.
 */

scenario("An app on an ask shows on its card in Now and in the conversation", { tag: ["@browser"] }, async ({ server, page, context }, info) => {
  info.setTimeout(90_000);
  // Given "devtool" asked in conversation 41 with a "Tokens per day" chart app attached
  const w = await browserWorld({ server, page, context }, { agents: ["devtool", "docs"], live: ["devtool"] });
  const conv = await createConversation(w.owner, { title: "Ship search filters", participants: ["devtool", "docs"] });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "convoz-draftask-"));
  const file = path.join(dir, "chart.json");
  fs.writeFileSync(file, JSON.stringify(validApp("chart-bar-prototype-a1")));
  const ran = await convoz(w.box, w.sessions.devtool!.sid, [
    "ask", String(conv), "--question", "Is this spend fine?", "--recommend", "Yes", "--why", "It is flat", "--alt", "No", "--alt-why", "It is high",
    "--owners-call", "taste", "--owners-call-why", "It is your budget", "--app", file,
  ]);
  expect({ code: ran.code, stderr: ran.stderr.trim() }).toEqual({ code: 0, stderr: "hint: use --action ... for a permission ask" });

  // When the owner opens Now
  await openNow(page, w.srv);

  // Then the card of the ask shows the chart "Tokens per day"
  await expect(appCard(page, "Tokens per day")).toBeVisible();

  // And conversation 41 shows the same chart on the card of the ask
  await page.goto(`${w.srv.origin}/chats/${conv}`);
  await expect(page.getByRole("region", { name: "Tokens per day", exact: true })).toBeVisible();
});

// ---- draft asks (Drew, conv 32 msg 650) -----------------------------------------------------------------------------

const QUESTION = "Send this reply to Alex?";
const DRAFT = "Sounds good, Thursday works.";
const EDITED = "Sounds good, Thursday at 10 works.";
const ORIGINAL = "Can we meet Thursday?";
const FROM = "Alex · Slack DM";
const CALL = "Your call · in-your-name: It goes out in your name.";

type Draftable = AskView & { draft?: { text: string; original?: string; original_from?: string }; reply?: { send: boolean; text?: string } };

/** `convoz ask --draft ...` as the agent; the ask id. */
async function agentDrafts(box: CliMachine, sid: string, conv: number, extra: string[] = []): Promise<number> {
  const ran = await convoz(box, sid, ["ask", "--json", "--draft", DRAFT, "--original", ORIGINAL, "--original-from", FROM, ...extra, String(conv), QUESTION]);
  expect({ code: ran.code, stderr: ran.stderr }).toEqual({ code: 0, stderr: "" });
  return JSON.parse(ran.stdout).id as number;
}

/** What the agent reads once the owner answered: the inbox item and the line of its watch, each with the reply of the ask. */
async function agentReads(w: World, sid: string, ask: number): Promise<{ inbox: unknown; watch: unknown }> {
  // Peek first: a watch finishes what it prints (owner msg 821, "Probably don't need an ack"), so the inbox is empty after it.
  const item = (await inboxItems(w.box, sid, ["--peek"])).find((i) => i.message.id === ask) as unknown as { reason: string; message: { ask?: Draftable } };
  const watch = startWatch(w.box, sid);
  try {
    const lines = await watchLines(watch, 1, 10_000);
    expect(item.reason).toBe("ask_resolved");
    return { inbox: item.message.ask?.reply, watch: (lines[0] as unknown as { reply?: unknown }).reply };
  } finally {
    await watch.stop();
  }
}

/** The owner changes the draft of a card. */
async function editDraft(page: Page, card: ReturnType<typeof askCard>, text: string): Promise<void> {
  const box = card.getByRole("textbox", { name: "Draft" });
  await expect(box).toHaveValue(DRAFT);
  await box.fill(text);
}

/** The card shows the question, the original quoted with its from-line and the draft in a box that fits the screen. */
async function expectDraftCard(page: Page, card: ReturnType<typeof askCard>): Promise<void> {
  await expect(card.getByText(CALL, { exact: true })).toBeVisible();
  await expect(card.locator("blockquote").getByText(FROM, { exact: true })).toBeVisible();
  await expect(card.locator("blockquote").getByText(ORIGINAL, { exact: true })).toBeVisible();
  await expect(card.getByRole("textbox", { name: "Draft" })).toHaveValue(DRAFT);
  // 16px text keeps a phone from zooming in when the box takes focus
  expect(await card.getByRole("textbox", { name: "Draft" }).evaluate((el) => parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(16);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
}

scenario("An agent asks the owner to review a draft and gets back the edited text", { tag: ["@browser"] }, async ({ server, page, context }, info) => {
  info.setTimeout(90_000);
  // Given "devtool" asked "Send this reply to Alex?" with the draft "Sounds good, Thursday works." in answer to "Can we meet Thursday?" from "Alex · Slack DM"
  const w = await browserWorld({ server, page, context }, { agents: ["devtool", "docs"], live: ["devtool"] });
  const conv = await createConversation(w.owner, { title: "Ship search filters", participants: ["devtool", "docs"] });
  const sid = w.sessions.devtool!.sid;
  const id = await agentDrafts(w.box, sid, conv);

  // When the owner opens Now
  await openNow(page, w.srv);

  // Then the card shows the question, the original quoted with its from-line and the draft in an editable box
  const card = askCard(page, QUESTION);
  await expectDraftCard(page, card);

  // And the card shows no "Edited" marker
  await expect(card.getByText("Edited", { exact: true })).toHaveCount(0);

  // When the owner changes the draft to "Sounds good, Thursday at 10 works."
  await editDraft(page, card, EDITED);

  // Then the card shows an "Edited" marker
  await expect(card.getByText("Edited", { exact: true })).toBeVisible();
  if (info.project.name === "mobile") await card.screenshot({ path: "/tmp/draftask-phone.png" });

  // When the owner taps "Send"
  await card.getByRole("button", { name: "Send", exact: true }).click();
  await expect(card).toHaveCount(0);

  // Then "devtool" gets the answer send true with the text "Sounds good, Thursday at 10 works." in its inbox and its watch
  const read = await agentReads(w, sid, id);
  expect(read).toStrictEqual({ inbox: { send: true, text: EDITED }, watch: { send: true, text: EDITED } });

  // And conversation 41 shows "Send: Sounds good, Thursday at 10 works."
  expect((await messagesOf(w.owner, conv)).map((m) => m.body)).toContain(`Send: ${EDITED}`);
  expect((await askOf(w.owner, id)).answer).toBe(`Send: ${EDITED}`);
  await page.goto(`${w.srv.origin}/chats/${conv}`);
  await expect(page.getByText(`Answered · Send: ${EDITED}`, { exact: true })).toBeVisible();
});

scenario("Don't send returns send false and no text", { tag: ["@browser"] }, async ({ server, page, context }, info) => {
  info.setTimeout(90_000);
  // Given "devtool" asked "Send this reply to Alex?" with the draft "Sounds good, Thursday works." in answer to "Can we meet Thursday?" from "Alex · Slack DM"
  const w = await browserWorld({ server, page, context }, { agents: ["devtool", "docs"], live: ["devtool"] });
  const conv = await createConversation(w.owner, { title: "Ship search filters", participants: ["devtool", "docs"] });
  const sid = w.sessions.devtool!.sid;
  const id = await agentDrafts(w.box, sid, conv);

  // When the owner opens Now and taps "Don't send"
  await openNow(page, w.srv);
  const card = askCard(page, QUESTION);
  await card.getByRole("button", { name: "Don't send", exact: true }).click();
  await expect(card).toHaveCount(0);

  // Then "devtool" gets the answer send false and no text in its inbox and its watch
  const read = await agentReads(w, sid, id);
  expect(read).toStrictEqual({ inbox: { send: false }, watch: { send: false } });

  // And conversation 41 shows "Don't send"
  expect((await messagesOf(w.owner, conv)).map((m) => m.body)).toContain("Don't send");
  expect(((await askOf(w.owner, id)) as Draftable).reply).toStrictEqual({ send: false });
});

scenario("A draft ask is reviewed inside the conversation too", { tag: ["@browser"] }, async ({ server, page, context }, info) => {
  info.setTimeout(90_000);
  // Given "devtool" asked "Send this reply to Alex?" with the draft "Sounds good, Thursday works." in answer to "Can we meet Thursday?" from "Alex · Slack DM"
  const w = await browserWorld({ server, page, context }, { agents: ["devtool", "docs"], live: ["devtool"] });
  const conv = await createConversation(w.owner, { title: "Ship search filters", participants: ["devtool", "docs"] });
  const sid = w.sessions.devtool!.sid;
  const id = await agentDrafts(w.box, sid, conv);

  // When the owner opens conversation 41, changes the draft to "Sounds good, Thursday at 10 works." and taps "Send"
  await page.goto(`${w.srv.origin}/chats/${conv}`);
  const card = askCard(page, QUESTION);
  await expectDraftCard(page, card);
  await editDraft(page, card, EDITED);
  await expect(card.getByText("Edited", { exact: true })).toBeVisible();
  if (info.project.name === "chromium") await page.screenshot({ path: "/tmp/draftask-desktop.png" });
  await card.getByRole("button", { name: "Send", exact: true }).click();

  // Then "devtool" gets the answer send true with the text "Sounds good, Thursday at 10 works." in its inbox and its watch
  const read = await agentReads(w, sid, id);
  expect(read).toStrictEqual({ inbox: { send: true, text: EDITED }, watch: { send: true, text: EDITED } });
});

scenario("A draft ask needs no owner's-call reason", { tag: ["@cli"] }, async ({ server }) => {
  const { w, conv, devtool } = await askWorld(server);

  // When "devtool" runs "convoz ask --draft 'Sounds good, Thursday works.' --original 'Can we meet Thursday?' --original-from 'Alex · Slack DM' 41 'Send this reply to Alex?'"
  const ran = await convoz(w.box, devtool.sid, ["ask", "--draft", DRAFT, "--original", ORIGINAL, "--original-from", FROM, String(conv), QUESTION]);

  // Then the command succeeds and the owner sees the ask in Now with the call "Your call · in-your-name: It goes out in your name."
  expect({ code: ran.code, stderr: ran.stderr }).toEqual({ code: 0, stderr: "" });
  const [card] = (await nowOf(w.owner)).asks as Draftable[];
  expect([card?.question, card?.owners_call, card?.draft, card?.options.map((o) => o.label)]).toEqual([
    QUESTION,
    { kind: "in-your-name", reason: "It goes out in your name." },
    { text: DRAFT, original: ORIGINAL, original_from: FROM },
    ["Send", "Don't send"],
  ]);

  // When "devtool" runs "convoz ask" with the call "in-your-name" and options but no draft
  const choice = await convoz(w.box, devtool.sid, [
    "ask", "--question", "Ship it?", "--recommend", "Ship", "--why", "Green", "--alt", "Wait", "--alt-why", "One more check", "--owners-call", "in-your-name", "--owners-call-why", "Because", String(conv),
  ]);

  // Then the command exits 2 and says the call is for a draft ask only
  expect(choice.code).toBe(2);
  expect(choice.stderr + choice.stdout).toContain("for a draft ask only");

  // When "devtool" runs "convoz ask --draft" with a recommendation as well
  const mixed = await convoz(w.box, devtool.sid, ["ask", "--draft", DRAFT, "--recommend", "Ship", "--why", "Green", String(conv), QUESTION]);

  // Then the command exits 2 and says a draft ask takes no options and no owner's call
  expect(mixed.code).toBe(2);
  expect(mixed.stderr).toContain("takes no options and no owner's call");
  expect((await nowOf(w.owner)).asks).toHaveLength(1);
});

scenario("A long original is cut and a long draft is refused", { tag: ["@cli"] }, async ({ server }) => {
  const { w, conv, devtool } = await askWorld(server);

  // When "devtool" runs "convoz ask --draft" with an original of 2500 characters
  const long = await convoz(w.box, devtool.sid, ["ask", "--draft", DRAFT, "--original", "o".repeat(2500), String(conv), QUESTION]);
  expect({ code: long.code, stderr: long.stderr }).toEqual({ code: 0, stderr: "" });

  // Then the owner sees the original cut to 2000 characters and ending with "…"
  const [card] = (await nowOf(w.owner)).asks as Draftable[];
  expect([...(card?.draft?.original ?? "")]).toHaveLength(2000);
  expect(card?.draft?.original?.endsWith("…")).toBe(true);

  // When "devtool" runs "convoz ask --draft" with a draft of 4001 characters
  const big = await convoz(w.box, devtool.sid, ["ask", "--draft", "d".repeat(4001), String(conv), "Send the long one?"]);

  // Then the command exits 2 and the owner sees no new ask
  expect(big.code).toBe(2);
  expect((await nowOf(w.owner)).asks).toHaveLength(1);
});

scenario("The ask tool takes a draft to review and needs no owner's call", { tag: ["@mcp"] }, async ({ server }) => {
  const { w, conv } = await askWorld(server);
  const mcp = await McpClient.start(w.box, "devtool", "claude-TESTONLY-mcp-draft");
  try {
    // When the "ask" tool is called with a question and a draft with the text of a reply, the message it answers and who sent it
    const result = await mcp.tool("ask", { conversation: conv, question: QUESTION, draft: { text: DRAFT, original: ORIGINAL, original_from: FROM } });
    expect(result.isError ?? false).toBe(false);

    // Then the owner sees a draft ask in Now with the call "Your call · in-your-name: It goes out in your name."
    const [card] = (await nowOf(w.owner)).asks as Draftable[];
    expect([card?.owners_call, card?.draft]).toEqual([{ kind: "in-your-name", reason: "It goes out in your name." }, { text: DRAFT, original: ORIGINAL, original_from: FROM }]);

    // And when the owner sends an edited text, the agent reads send true with that text, and with Don't send it reads send false and no text
    must(await answerAsk(w.owner, card!.id, { choice: "recommended" }, { text: EDITED }), "send the draft", 200);
    expect(((await askOf(w.owner, card!.id)) as Draftable).reply).toStrictEqual({ send: true, text: EDITED });
    const second = await mcp.tool("ask", { conversation: conv, question: "Send the other one?", draft: { text: "No." } });
    expect(second.isError ?? false).toBe(false);
    const next = (await nowOf(w.owner)).asks[0]!;
    must(await answerAsk(w.owner, next.id, { choice: "alternative", index: 1 }), "do not send", 200);
    expect(((await askOf(w.owner, next.id)) as Draftable).reply).toStrictEqual({ send: false });
  } finally {
    mcp.end();
  }
});

scenario("A draft ask is checked, stored with a fixed owner's call and answered with Send or Don't send", { tag: ["@api"] }, async ({ server }) => {
  const { w, conv, devtool } = await askWorld(server);
  const draftBody = (draft: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
    conversation_id: conv, client_id: askBody(conv).client_id, question: QUESTION, draft, ...extra,
  });
  const refused = async (body: Record<string, unknown>) => {
    const res = await postAsk(w.srv, devtool.lease, body);
    return { status: res.status, field: res.json().error?.field, message: res.json().error?.message as string };
  };

  // When "devtool" posts a draft ask with a draft of 4001 characters, Then the server answers 400 naming "draft"
  expect(await refused(draftBody({ text: "d".repeat(4001) }))).toMatchObject({ status: 400, field: "draft" });

  // When "devtool" posts a draft ask with an original of 2001 characters, Then the server answers 400 naming "original"
  expect(await refused(draftBody({ text: DRAFT, original: "o".repeat(2001) }))).toMatchObject({ status: 400, field: "original" });

  // When "devtool" posts an ask with owners_call kind "in-your-name" and options but no draft, Then the server answers 400 naming "owners_call" with the words "draft ask only"
  const plain = askBody(conv, { ownersCall: { kind: "in-your-name" as never, reason: "Because" } });
  const wrongKind = await refused(plain);
  expect(wrongKind).toMatchObject({ status: 400, field: "owners_call" });
  expect(wrongKind.message).toContain("draft ask only");

  // When "devtool" posts a draft ask with no owners_call and no options, Then the server answers 201 and GET shows the fixed call, the draft and the options
  const made = must(await postAsk(w.srv, devtool.lease, draftBody({ text: DRAFT, original: ORIGINAL, original_from: FROM })), "draft ask", 201).json().ask as Draftable;
  const got = (await askOf(w.owner, made.id)) as Draftable;
  expect([got.owners_call, got.draft, got.options.map((o) => o.label)]).toEqual([
    { kind: "in-your-name", reason: "It goes out in your name." },
    { text: DRAFT, original: ORIGINAL, original_from: FROM },
    ["Send", "Don't send"],
  ]);

  // When the owner answers "recommended" with a text of 4001 characters, Then the server answers 400 naming "text"
  const tooLong = await answerAsk(w.owner, made.id, { choice: "recommended" }, { text: "t".repeat(4001) });
  expect([tooLong.status, tooLong.json().error?.field]).toEqual([400, "text"]);

  // When the owner answers "custom" with a text, Then the server answers 400 naming "choice"
  const custom = await answerAsk(w.owner, made.id, { choice: "custom", text: "Hello" });
  expect([custom.status, custom.json().error?.field]).toEqual([400, "choice"]);

  // When the owner answers "recommended" with the text "Final words", Then GET shows the reply send true with the text "Final words" and the answer "Send: Final words"
  must(await answerAsk(w.owner, made.id, { choice: "recommended" }, { text: "Final words" }), "send", 200);
  const done = (await askOf(w.owner, made.id)) as Draftable;
  expect([done.reply, done.answer]).toEqual([{ send: true, text: "Final words" }, "Send: Final words"]);
});
