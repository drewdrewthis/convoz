import { createConversation, peekFor } from "../lib/chat.ts";
import { agentAsks, QUESTION } from "../lib/asks.ts";
import { messageLog } from "../lib/chat-ui.ts";
import { callButton, callPill, callStatus, callWorld, CALLS_TITLE, fakeMic, fakeModel, KEY, micStates, nowCallLogs, onANowCall, openConversation, ownerPosts, searchDialog, startNowCallFromSearch, tokenRequests, trackMicrophone, visibleLink, voiceKey, voicePosts } from "../lib/call.ts";
import { must } from "../lib/owner.ts";
import { expect, scenario, test } from "../lib/scenario.ts";
import { raw } from "../lib/uploads-wp10.ts";

/*
 * THE NOW CALL: specs/features/voice-call.feature and specs/contracts/voice-call.feature, the rules on calling Now
 * (issue https://github.com/drewdrewthis/convoz/issues/43, phase 1). The same call as in a conversation, aimed at Now: it reads what
 * waits on the owner; its writes are in voice-call-writes.spec.ts. The fakes are those of voice-call.spec.ts; the page contract is the block atop lib/call.ts.
 */

test.use({ launchOptions: fakeMic });

const GOOGLE = "generativelanguage.googleapis.com";
/** The tools of a Now call: its reads, then its writes (each held for the owner's yes, voice-call-writes.spec.ts). */
const READS = ["read_now", "list_conversations", "search_messages", "read_conversation", "agent_status"];
const WRITES = ["post_message", "start_conversation", "message_agent", "reply_in_thread", "answer_ask", "snooze_ask", "mark_stale", "star_conversation", "confirm_action", "cancel_action"];

// ---- the feature ---------------------------------------------------------------------------------------

scenario("A Now call starts from the search overlay", { tag: ["@browser"] }, async ({ server, page, context }) => {
  // Background
  const u = await callWorld({ server, page, context });
  await voiceKey(u.w, KEY);
  const model = await fakeModel(page);
  await trackMicrophone(page);
  await page.goto(`${u.w.srv.origin}/`);
  await page.getByRole("heading", { name: "Now", exact: true }).waitFor();

  // When the owner opens the search overlay and picks the quick action "Call"
  await startNowCallFromSearch(page);

  // Then the call pill shows that the call is live, with the time, Mute and Hang up
  await expect(searchDialog(page)).toHaveCount(0);
  await expect(callStatus(page)).toHaveText("Live");
  await expect(callPill(page).getByRole("timer", { name: "Time on the call" })).toHaveText(/^\d+:\d\d$/);
  await expect(callPill(page).getByRole("button", { name: "Mute" })).toBeVisible();
  await expect(callPill(page).getByRole("button", { name: "Hang up" })).toBeVisible();
  expect(model.sent[0].setup.model).toBe("models/gemini-3.8-live");

  // And the pill sits below the page's content, covering none of it
  const content = (await page.locator("main").boundingBox())!;
  const pill = (await callPill(page).boundingBox())!;
  expect(pill.y).toBeGreaterThanOrEqual(content.y + content.height);
});

// Owner polish (relayed 2026-10-22): "Call" sat under five Recent rows, below the fold of a short window and under a phone's keyboard.
scenario("Call is in view as soon as the search overlay opens", { tag: ["@browser"] }, async ({ server, page, context }, info) => {
  // Given the owner has 5 recent conversations
  const u = await callWorld({ server, page, context });
  await voiceKey(u.w, KEY);
  const ids: number[] = [];
  for (let i = 1; i <= 5; i++) ids.push(await createConversation(u.w.owner, { participants: ["dot"], title: `Recent conversation ${i}` }));
  if (info.project.name === "chromium") await page.setViewportSize({ width: 1280, height: 700 });
  await page.goto(`${u.w.srv.origin}/`);
  await page.evaluate((list) => localStorage.setItem("convoz.recent-chats", JSON.stringify(list)), ids);
  await page.reload();
  await page.getByRole("heading", { name: "Now", exact: true }).waitFor();

  // When the owner opens the search overlay with Cmd+K, on a 1280 by 700 window and on a phone
  await page.keyboard.press("ControlOrMeta+K");

  // Then "Quick actions" comes before "Recent" and the option "Call" is wholly in view
  const groups = searchDialog(page).getByRole("group");
  await expect(groups).toHaveCount(2);
  expect(await groups.evaluateAll((list) => list.map((g) => g.getAttribute("aria-label")))).toEqual(["Quick actions", "Recent"]);
  await expect(searchDialog(page).getByRole("group", { name: "Recent" }).getByRole("option")).toHaveCount(5);
  await expect(searchDialog(page).getByRole("option", { name: /^Call\b/ })).toBeInViewport({ ratio: 1 });
});

scenario("The call pill stays on every screen while the owner moves around", { tag: ["@browser"] }, async ({ server, page, context }) => {
  // Background
  const u = await callWorld({ server, page, context });
  await voiceKey(u.w, KEY);

  // Given the owner is on a Now call
  const model = await onANowCall(page, u.w.srv);
  expect(await micStates(page)).toEqual(["live"]);

  // When the owner goes to Crew, then to conversation 41, then back to Now
  // Then the call pill shows on each screen and the call stays live
  await visibleLink(page, "Crew").click();
  await expect(page.getByRole("heading", { name: "Crew", exact: true })).toBeVisible();
  await expect(callStatus(page)).toHaveText("Live");

  await page.keyboard.press("ControlOrMeta+K");
  await searchDialog(page).getByRole("combobox", { name: "Search" }).fill("Ship search filters");
  await searchDialog(page).getByRole("group", { name: "Conversations" }).getByRole("option").first().click();
  await expect(messageLog(page)).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/chats/${u.conv}$`));
  await expect(callStatus(page)).toHaveText("Live");

  await page.getByRole("link", { name: /^Back/ }).click();
  await expect(page.getByRole("heading", { name: "Crew", exact: true })).toBeVisible();
  // Back to Now: on a wide screen the Now button turns the rail into the Now list (rail.feature, "On a wide screen Now is a view
  // of the rail"); on a phone the tab bar link opens the Now page.
  if ((page.viewportSize()?.width ?? 0) >= 900) {
    const rail = page.getByRole("navigation", { name: "Conversations" });
    await rail.getByRole("button", { name: /^Now\b/ }).click();
    await expect(rail.getByRole("button", { name: /^Now\b/ })).toHaveAttribute("aria-pressed", "true");
    await expect(rail.getByText("All clear. Nothing needs you.")).toBeVisible();
  } else {
    await visibleLink(page, /^Now\b/).click();
    await expect(page.getByRole("heading", { name: "Now", exact: true })).toBeVisible();
  }
  await expect(callStatus(page)).toHaveText("Live");

  // And the microphone stays on: one track, still live, and the one socket to the model is still open
  expect(await micStates(page)).toEqual(["live"]);
  expect(model.closed()).toBe(false);
  expect(model.sent.filter((m) => m.setup)).toHaveLength(1);
});

scenario("The model reads Now and the answer holds the asks that wait", { tag: ["@browser"] }, async ({ server, page, context }, info) => {
  // Background
  const u = await callWorld({ server, page, context });
  await voiceKey(u.w, KEY);
  // Given "dot" asked "Merge #415 on its own?" in conversation 41
  await agentAsks(u.w.srv, u.dot.lease, u.conv);
  // And the owner is on a Now call
  const model = await onANowCall(page, u.w.srv);

  // When the model asks for read_now
  model.call("read_now", {});

  // Then the answer to the model holds "Merge #415 on its own?" from "dot" in "Ship search filters"
  await expect.poll(() => model.responses()).toHaveLength(1);
  expect(model.responses()[0].response).toMatchObject({ asks: [{ question: QUESTION, from: "dot", conversation: "Ship search filters", conversation_id: u.conv, urgent: false }] });
  await expect(page.getByRole("article", { name: QUESTION })).toBeVisible();
  await page.screenshot({ path: info.outputPath("now-call-pill.png") });
});

scenario("A Now call cannot ask an agent", { tag: ["@browser"] }, async ({ server, page, context }) => {
  // Background
  const u = await callWorld({ server, page, context });
  await voiceKey(u.w, KEY);

  // Given the owner is on a Now call
  const model = await onANowCall(page, u.w.srv);

  // When the owner says "ask dot to merge it" and the model asks dot "merge it"
  model.hear("ask dot to merge it");
  model.call("ask_agent", { handle: "dot", text: "merge it" });

  // Then no conversation shows a message to "@dot"
  await expect.poll(() => model.responses()).toHaveLength(1);
  expect(await ownerPosts(u.w, u.conv)).toEqual([]);
  expect(await voicePosts(u.w, u.conv)).toEqual([]);

  // And the call answers the model that there is no such tool
  expect(model.responses()[0].response).toEqual({ error: "no such tool" });
});

scenario("Typing \"@voice\" does not open the microphone", { tag: ["@browser"] }, async ({ server, page, context }) => {
  // Background
  const u = await callWorld({ server, page, context });
  await voiceKey(u.w, KEY);
  await trackMicrophone(page);
  await page.addInitScript(() => {
    const w = window as unknown as { __asked: number };
    w.__asked = 0;
    const md = navigator.mediaDevices;
    if (!md) return;
    const original = md.getUserMedia.bind(md);
    md.getUserMedia = (c) => {
      w.__asked++;
      return original(c);
    };
  });

  // When the owner types "@voice" in the box of conversation 41
  await openConversation(page, u.w.srv, u.conv);
  await expect(callButton(page)).toBeVisible();
  const box = page.getByRole("textbox", { name: /^Message/ });
  await box.click();
  await box.pressSequentially("@voice");
  await box.press("Space");

  // Then the microphone was never asked for and there is no call
  expect(await page.evaluate(() => (window as unknown as { __asked: number }).__asked)).toBe(0);
  expect(await micStates(page)).toEqual([]);
  await expect(callPill(page)).toHaveCount(0);
});

scenario("Hanging up a Now call ends the microphone and the connection", { tag: ["@browser"] }, async ({ server, page, context }) => {
  // Background
  const u = await callWorld({ server, page, context });
  await voiceKey(u.w, KEY);

  // Given the owner is on a Now call
  const model = await onANowCall(page, u.w.srv);
  expect(await micStates(page)).toEqual(["live"]);

  // When the owner taps Hang up on the call pill
  await callPill(page).getByRole("button", { name: "Hang up" }).click();

  // Then the microphone is off and the connection to the model is closed
  await expect.poll(() => micStates(page)).toEqual(["ended"]);
  await expect.poll(() => model.closed()).toBe(true);

  // And the call pill is gone
  await expect(callPill(page)).toHaveCount(0);
});

scenario("A Now call leaves its log once, in \"Calls with @voice\", and wakes nobody", { tag: ["@browser", "@cli"] }, async ({ server, page, context }) => {
  // Background
  const u = await callWorld({ server, page, context });
  await voiceKey(u.w, KEY);

  // Given the owner is on a Now call and the model read Now
  let model = await onANowCall(page, u.w.srv);
  model.hear("what waits on me?");
  model.call("read_now", {});
  await expect.poll(() => model.responses()).toHaveLength(1);
  model.speak("Nothing waits on you.");

  // When the owner taps Hang up on the call pill
  await callPill(page).getByRole("button", { name: "Hang up" }).click();

  // Then the conversation "Calls with @voice" holds one "Call log" message from the owner, marked "via voice call"
  await expect.poll(async () => (await nowCallLogs(u.w)).logs.length).toBe(1);
  const first = await nowCallLogs(u.w);
  expect(first.conversations).toHaveLength(1);
  expect(first.logs[0]).toMatchObject({ via_voice: true });
  expect(first.logs[0]!.body).toContain("owner: what waits on me?");
  expect(first.logs[0]!.body).toContain("model: Nothing waits on you.");
  expect(first.logs[0]!.body).toContain("ended: hung up by the owner");
  expect(await ownerPosts(u.w, u.conv)).toEqual([]);

  // And a second Now call adds its log to the same conversation
  model = await onANowCall(page, u.w.srv);
  model.hear("anything new?");
  await callPill(page).getByRole("button", { name: "Hang up" }).click();
  await expect.poll(async () => (await nowCallLogs(u.w)).logs.length).toBe(2);
  expect((await nowCallLogs(u.w)).conversations).toEqual(first.conversations);

  // And "dot" has no inbox item for any call log
  expect(await peekFor(u.w.box, u.dot.sid, first.conversations[0]!)).toEqual([]);
  expect((await peekFor(u.w.box, u.dot.sid, u.conv)).filter((i) => i.message.body.includes("Call log"))).toEqual([]);
});

scenario("A Now call that ends with a reload still leaves its log", { tag: ["@browser"] }, async ({ server, page, context }) => {
  // Background
  const u = await callWorld({ server, page, context });
  await voiceKey(u.w, KEY);

  // Given the owner is on a Now call and the model read Now
  const model = await onANowCall(page, u.w.srv);
  model.hear("what waits on me?");
  model.call("read_now", {});
  await expect.poll(() => model.responses()).toHaveLength(1);

  // When the owner reloads the page
  await page.reload();
  await page.getByRole("heading", { name: "Now", exact: true }).waitFor();

  // Then the conversation "Calls with @voice" holds one "Call log" message that says the call ended
  await expect.poll(async () => (await nowCallLogs(u.w)).logs.length).toBe(1);
  const { logs } = await nowCallLogs(u.w);
  expect(logs[0]!.body).toContain("owner: what waits on me?");
  expect(logs[0]!.body).toMatch(/ended: /);
  await expect(callPill(page)).toHaveCount(0);
});

// ---- the contracts ---------------------------------------------------------------------------------------

scenario("The owner gets a Now token that locks the triage instructions and tools", { tag: ["@api"] }, async ({ server }) => {
  // Background
  const u = await callWorld({ server });

  // Given voice is on with the key "TESTONLY-gemini"
  await voiceKey(u.w, KEY);

  // When the owner asks for a voice token with the scope "now"
  const res = must(await u.w.owner.client.post("/api/voice/token", { scope: "now" }), "now token");

  // Then the server answers 200 with a token, the model, the socket address and an expiry
  const out = res.json();
  expect(out.token).toMatch(/^auth_tokens\/\S+$/);
  expect(out.model).toBe("gemini-3.8-live");
  expect(out.ws_url).toMatch(new RegExp(`^wss://${GOOGLE}/`));
  expect(out.expires_at).toBeGreaterThan(0);

  // And it was asked to lock the model "gemini-3.8-live", the triage instructions, the reads "read_now", "list_conversations", "search_messages", "read_conversation" and "agent_status", and the writes held for a yes
  const asked = await tokenRequests(u.w);
  expect(asked).toHaveLength(1);
  const setup = asked[0]!.body.bidiGenerateContentSetup;
  expect(asked[0]!.body.uses).toBe(1);
  expect(setup.model).toBe("models/gemini-3.8-live");
  const names = setup.tools[0].functionDeclarations.map((f: { name: string }) => f.name);
  expect(names).toEqual([...READS, ...WRITES]);
  expect(out.config.tools).toEqual(setup.tools);
  const words = setup.systemInstruction.parts[0].text as string;
  expect(words).toContain("read_now");
  expect(words).toMatch(/most urgent first/);
  expect(words).toMatch(/untrusted/i);
  expect(out.config.systemInstruction).toBe(words);

  // And the instructions tell the model to search and read before it answers about a topic, and to say when it is not sure
  expect(words).toMatch(/call search_messages .* then read_conversation/);
  expect(words).toMatch(/not sure/);

  // And the instructions tell the model to say each read-back and to call confirm_action only on the owner's yes
  expect(words).toMatch(/read_back to him word for word/);
  expect(words).toMatch(/[Cc]all confirm_action only when he says yes/);

  // And no "ask_agent" is offered
  expect(names).not.toContain("ask_agent");

  // And the key "TESTONLY-gemini" is nowhere in the answer
  expect(res.text).not.toContain(KEY);
});

scenario("An agent cannot get a Now token", { tag: ["@api"] }, async ({ server }) => {
  // Background
  const u = await callWorld({ server });

  // Given voice is on with the key "TESTONLY-gemini"
  await voiceKey(u.w, KEY);

  // When "dot" asks for a voice token with the scope "now"
  const res = await raw({ srv: u.w.srv, lease: u.dot.lease }, "POST", "/api/voice/token", { json: { scope: "now" } });

  // Then the server answers 403
  expect(res.status).toBe(403);
  // And the token service was not asked
  expect(await tokenRequests(u.w)).toEqual([]);
});

scenario("A token request without a conversation is the triage call, and one naming both is refused", { tag: ["@api"] }, async ({ server }) => {
  // Background
  const u = await callWorld({ server });

  // Given voice is on with the key "TESTONLY-gemini"
  await voiceKey(u.w, KEY);

  // When the owner asks for a voice token with the scope "now" and conversation 41
  const both = await u.w.owner.client.post("/api/voice/token", { scope: "now", conversation_id: u.conv });
  // Then the server answers 400 naming "scope"
  expect(both.status).toBe(400);
  expect(both.json().error.field).toBe("scope");

  // And the token service was not asked
  expect(await tokenRequests(u.w)).toEqual([]);

  // When the owner asks for a voice token with no conversation and no scope
  // Owner said (conv 108 msg 2846): "the voice should be triage by default"
  const neither = must(await u.w.owner.client.post("/api/voice/token", {}), "default token");
  // Then the server answers 200 and the token locks the same triage reads and writes
  expect(neither.json().config.tools[0].functionDeclarations.map((f: { name: string }) => f.name)).toEqual([...READS, ...WRITES]);
});

scenario("Now tokens count against the same 20 an hour", { tag: ["@api"] }, async ({ server }) => {
  // Background
  const u = await callWorld({ server });

  // Given voice is on with the key "TESTONLY-gemini"
  await voiceKey(u.w, KEY);

  // When the owner asks for 20 voice tokens for conversation 41
  for (let i = 0; i < 20; i++) must(await u.w.owner.client.post("/api/voice/token", { conversation_id: u.conv }), `voice token ${i + 1}`);

  // And the owner asks for a voice token with the scope "now"
  const res = await u.w.owner.client.post("/api/voice/token", { scope: "now" });

  // Then the server answers 429 with a Retry-After header
  expect(res.status).toBe(429);
  expect(Number(res.headers["retry-after"])).toBeGreaterThan(0);
});
