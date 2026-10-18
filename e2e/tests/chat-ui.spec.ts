import { agentPosts, appReturns, agentChoice, chooseAgent, openMentions, backButton, chatList, chatRow, chatsHeading, composer, nowHeading, dropStreams, fromBottom, hasBubble, isBold, mainNav, message, messageLog, newChat, newMessagePill, pushFrame, rowTitles, sendButton, smallChatTargets, streamOpen, uiWorld, unreadDot, workingNote } from "../lib/chat-ui.ts";
import { agentAsks, askCard, openNow } from "../lib/asks.ts";
import { convoz, createConversation, listConversations, messagesOf, ownerSays, startWatch, unreadOf, watchLines, chatWorld } from "../lib/chat.ts";
import { loadRenderMarkdown } from "../lib/chat-markdown.ts";
import { backgroundLuminance, box, overflowX } from "../lib/mobile.ts";
import { expect, scenario } from "../lib/scenario.ts";
import { webauthn } from "../lib/webauthn-browser.ts";

/*
 * CHAT MVP, PR 2 CONTRACT: the phone chat UI in the Go-served console (plain JS, templates chats.html and chat.html, static chat.js).
 * Read with specs/features/conversations.feature, composer.feature and rail.feature, the chat MVP plan (with "DA amendments" and
 * "Advisor decisions after DA") and the UI contract atop tests/console-mobile.spec.ts. Where this block and the plan differ, this
 * block is what the bindings assert; the PR summary lists each difference. The API and CLI contract is atop tests/chat-api.spec.ts.
 * Locators are role, accessible name and text only (plus plain tags p, pre, code, img, a for the markdown checks), so the S-U React app
 * can pass the same tests. Scenarios tagged @phone run only in the "mobile" project (390x844, touch, coarse pointer); the others
 * run in "chromium" (desktop) and in "mobile". The ceremony guard of the mobile project applies as before.
 *
 * SHELL (every signed-in page; prototype v41, see tests/prototype-parity.spec.ts)
 *   navigation "Main" (bottom, a floating bar): links "Now" (/), "Conversations" (/chats), "Crew" (/crew), in that order, no listitem.
 *   aria-current="page" on the current tab only (/chats and /chats/new -> Conversations). The bar floats 12 px above the bottom edge
 *   (safe-area padding). Account is not a tab: the "Account menu" button sits in the top bar.
 *   Inside an open chat (/chats/:id, /chats/new) the bar is hidden and the app bar shows link "Back" instead (plan D-2).
 *   After a good sign-in at /signin the browser lands on / (heading "Now"); opening /signin while signed in goes to /.
 *   <meta name="viewport"> contains viewport-fit=cover and interactive-widget=resizes-content.
 *
 * CHATS  /chats   heading "Conversations" (exact, level 1). Link "New conversation" (to /chats/new), a button that floats above the bar.
 *   Empty (no conversation): no list. Text /no conversations yet/i and text /agent/i (typing @ brings in an agent). The page body (main) also
 *   has link "New conversation". With chats: list "Conversations" with one listitem per conversation, in the OWNER'S order (rank DESC, id DESC; per prototype v41 new
 *   activity never reorders rows; Reorder mode, from a row's long-press menu, shows a handle on each row until Done). A listitem has: a link to /chats/:id that fills the row (the whole row is the tap target, >= 44 px
 *   tall); heading (level 2) = the title ("New conversation" while untitled); a preview line "devtool: Done" (agent) or "You: ..." (owner);
 *   when unread > 0: the count pill (text "Unread: 3": a hidden "Unread: " and the count; prototype v41 has no dot), and the title heading is bold (weight >= 600).
 *   Read rows: no dot, no count, normal weight. Live: SSE frames (message.created, read.moved, conversation.created) update the rows
 *   and the order with no reload. Opening a chat marks it read (POST read), so a reload keeps it cleared.
 *
 * NEW CHAT  /chats/new   app bar: link "Back", heading "New conversation" (level 1) over a blank chat: the hint "Type @ to bring in an agent." and the composer. List "Agents" with one
 *   button per enabled crew agent (GET /api/identities), in the menu that opens above the composer when the text ends in "@" (list "Agents"). The button's name holds "@<handle>" and the word "Online" (agent has a live
 *   lease: `online:true`) or "Offline"; the display name may be there too. One tap picks one agent: the picker is replaced by the empty
 *   chat of that agent (the URL may carry ?with=<handle>; no conversation exists yet) and the composer has focus. The message log is empty.
 *   The first Send makes POST /api/conversations then POST .../messages (a client id for each) and then shows /chats/:id.
 *   Cmd+J / Ctrl+J on desktop, anywhere in the console, opens /chats/new.
 *
 * CHAT  /chats/:id   app bar: link "Back" (to /chats; with history it goes back one step), heading (level 1) = title, and under it the
 *   text "@<handle>" of the agent. Browser back goes to the page before. Not a conversation of the owner -> 404 page.
 *   log "Messages": the scroll container (the app bar and the composer stay fixed; the page itself does not scroll). It holds one
 *   article per message in id order. Every message is laid out as prototype v42 does: the article has NO background and is the full width
 *   of the message column (12 px gutters on a phone, a centred 760 px column on a desktop). An agent's message has one author line (an
 *   avatar, the name, "@<handle>" and the time; once per run of messages from the same author) over its body. The owner's message is a
 *   compact bubble on the right (at most 85% wide) with its time above it; "You" is read, not shown. The body is text
 *   (white-space pre-wrap): never HTML. Agent bodies in format markdown are rendered: paragraphs (p), fenced code (pre > code, scrolls
 *   sideways inside itself), inline code (code), links (a with href http/https/mailto only, target=_blank, rel containing noopener and
 *   noreferrer), line breaks. Anything else, including <img onerror>, shows as literal text. Owner bodies are always plain text.
 *   Owner send state inside its article: text "sending" until the server confirms; on failure the text "failed · retry" (retry is the button)
 *   (same client id, so the retry never makes a second message); confirmed: no label.
 *   Opening scrolls the log to its bottom (the latest message is in view). A message that arrives while the log is within 80 px of the
 *   bottom keeps it at the bottom. A message that arrives while it is further up does not move the log and shows button "New message ↓"
 *   (above the composer); tapping it scrolls to the bottom and removes it; scrolling to the bottom by hand removes it too.
 *   Replying note: role=status with text "@<handle> is replying…" ("@a and @b are replying…" for several) shown from the live frame agent.working (working:true, handle,
 *   conversation_id) until a message from that agent arrives in the chat, a frame with working:false, or `until` (optional, epoch ms in
 *   the frame; the page hides the note at that time even if no frame follows; plan DA amendment 4 plus this addition).
 *   Composer: form "Composer", pinned to the bottom of the visible screen: its bottom edge touches the bottom of the layout viewport
 *   (safe-area padding), follows window.visualViewport (height + offsetTop on its resize and scroll events, for iOS Safari which ignores
 *   interactive-widget), and is never under the keyboard. Inside: textbox "Message @<handle>" (textarea, rows=1, autofocus on /chats/new
 *   after the pick, grows to at most 6 lines (about 180 px) and then scrolls inside itself) and button "Send" (round, disabled while the
 *   text is blank or whitespace). Enter: on a coarse pointer or a screen <= 600 px wide, Enter inserts a new line and only Send sends;
 *   otherwise Enter sends and Shift+Enter inserts a line. Sending clears and keeps focus on the textbox.
 *   Live and catch-up: one EventSource('/api/stream') per page. On stream error-then-open, on window "online", on document
 *   visibilitychange to visible and on window "pageshow" (also persisted) the page fetches .../messages?after=<last id> and the list and
 *   merges by message id: nothing is shown twice, nothing is lost, order is by id. Opening a chat and every message that arrives while
 *   the chat is visible moves the read cursor (POST .../read {main_id}).
 *
 * LAYOUT  No page is wider than the screen at 390 px and at 320 px (long words wrap, code scrolls inside its own box). Buttons, links
 *   in the app bar, list rows, the textbox and the nav are >= 44 px tall. Dark by default; light under prefers-color-scheme: light:
 *   body background luminance < 0.25 and > 0.75.
 */

const VIEW = { width: 390, height: 844 };
const FIRST = "Is the build green?";

scenario("On a phone the first page after sign-in is Now", { tag: ["@browser", "@phone"] }, async ({ server, page, context }) => {
  // Given the owner has a passkey on a phone
  const w = await chatWorld(server, { agents: ["devtool"] });
  const wa = await webauthn(context, page);
  await (await wa.add()).addCredential(w.owner.soft.exportForChromium());

  // When the owner signs in
  await page.goto(`${w.srv.origin}/signin`);
  await page.getByRole("button", { name: "Sign in with a passkey" }).click();

  // Then the app shows Now
  await expect(nowHeading(page)).toBeVisible();
  await expect(page).toHaveURL(`${w.srv.origin}/`);

  // And "Now" is marked as the current tab
  await expect(mainNav(page).getByRole("link", { name: "Now" })).toHaveAttribute("aria-current", "page");
});

scenario("On a phone the bottom bar leads to Now, Conversations and Crew", { tag: ["@browser", "@phone"] }, async ({ server, page, context }) => {
  // Given the owner opens Convoz on a phone
  const u = await uiWorld({ server, page, context });
  await page.goto(`${u.w.srv.origin}/`);

  // Then a bottom bar shows "Now", "Conversations" and "Crew"
  const nav = mainNav(page);
  await expect(nav.getByRole("link")).toHaveText(["Now", "Conversations", "Crew"]);
  await expect(nav.getByRole("link", { name: "Now" })).toHaveAttribute("aria-current", "page");
  const bar = await box(nav);
  expect(bar.y + bar.height).toBeGreaterThanOrEqual(VIEW.height - 12.5); // the bar floats 12 px above the edge

  // When the owner taps "Conversations"
  await nav.getByRole("link", { name: "Conversations" }).click();

  // Then the Conversations list shows with a "New conversation" button
  await expect(chatsHeading(page)).toBeVisible();
  await expect(newChat(page)).toBeVisible();

  // And "Conversations" is marked as the current tab
  await expect(nav.getByRole("link", { name: "Conversations" })).toHaveAttribute("aria-current", "page");
  await expect(nav.getByRole("link", { name: "Now" })).not.toHaveAttribute("aria-current", "page");
  await expect(page.locator('meta[name="viewport"]')).toHaveAttribute("content", /viewport-fit=cover/);
  await expect(page.locator('meta[name="viewport"]')).toHaveAttribute("content", /interactive-widget=resizes-content/);
});

scenario("On a phone an empty Conversations list explains itself and offers New conversation", { tag: ["@browser", "@phone"] }, async ({ server, page, context }) => {
  // Given the owner has no conversations yet
  const u = await uiWorld({ server, page, context });

  // When the owner opens Conversations on a phone
  await page.goto(`${u.w.srv.origin}/chats`);

  // Then the page says there are no conversations yet and that typing @ brings in an agent
  const body = page.getByRole("main");
  await expect(body).toContainText(/no conversations yet/i);
  await expect(body).toContainText(/agent/i);
  await expect(chatList(page)).toHaveCount(0);

  // And the page offers "New conversation"
  await expect(body.getByRole("link", { name: "New conversation" })).toBeVisible();
  await body.getByRole("link", { name: "New conversation" }).click();
  await expect(page).toHaveURL(`${u.w.srv.origin}/chats/new`);
});

scenario("On a phone New conversation opens a blank composer where @ lists the crew agents", { tag: ["@browser", "@phone"] }, async ({ server, page, context }) => {
  // Given "devtool" has a live session and "docs" has none
  const u = await uiWorld({ server, page, context, live: ["devtool"] });
  await page.goto(`${u.w.srv.origin}/chats`);

  // When the owner taps "New conversation" and types "@"
  await newChat(page).click();
  await openMentions(page);

  // Then the list shows "devtool" as online and "docs" as offline
  await expect(page.getByRole("list", { name: "Agents" }).getByRole("button")).toHaveCount(2);
  await expect(agentChoice(page, "devtool")).toContainText(/\bonline\b/i);
  await expect(agentChoice(page, "docs")).toContainText(/\boffline\b/i);

  // When the owner picks "docs"
  await agentChoice(page, "docs").click();

  // Then the message box for "docs" has focus
  await expect(composer(page)).toBeFocused();
  await expect(composer(page)).toHaveAccessibleName("Message @docs");
  await expect(messageLog(page).getByRole("article")).toHaveCount(0);
});

scenario("A new conversation starts blank and takes a title from its first message", { tag: ["@browser"] }, async ({ server, page, context }) => {
  // Given the owner is on the Conversations list
  const u = await uiWorld({ server, page, context });
  await page.goto(`${u.w.srv.origin}/chats`);

  // When the owner starts a new conversation with Cmd+J and sends "Plan the search filters launch"
  await page.keyboard.press("ControlOrMeta+j");
  await expect(page).toHaveURL(`${u.w.srv.origin}/chats/new`);
  await chooseAgent(page, "devtool");
  await expect(messageLog(page).getByRole("article")).toHaveCount(0);
  await composer(page).fill("Plan the search filters launch");
  await sendButton(page).click();

  // Then the Conversations list shows the conversation at the top titled "Plan the search filters launch"
  await expect(page.getByRole("heading", { level: 1, name: "Plan the search filters launch" })).toBeVisible();
  await backButton(page).click();
  await expect(chatList(page).getByRole("heading").first()).toHaveText("Plan the search filters launch");
  expect((await listConversations(u.w.owner))[0]?.title).toBe("Plan the search filters launch");
});

scenario("On a phone a new conversation takes its title from the first message and goes to the top of Conversations", { tag: ["@browser", "@phone"] }, async ({ server, page, context }) => {
  // Given the owner has conversations "Ship search filters" and "Deploy alerts runbook" on a phone
  const u = await uiWorld({ server, page, context });
  await createConversation(u.w.owner, { participants: ["devtool"], title: "Ship search filters" });
  await createConversation(u.w.owner, { participants: ["devtool"], title: "Deploy alerts runbook" });
  await page.goto(`${u.w.srv.origin}/chats`);

  // When the owner taps "New conversation", types "@", picks "devtool" and sends "Plan the search filters launch"
  await newChat(page).click();
  await chooseAgent(page, "devtool");
  await composer(page).fill("Plan the search filters launch");
  await sendButton(page).click();

  // Then the conversation is titled "Plan the search filters launch" and names "@devtool"
  const title = page.getByRole("heading", { level: 1, name: "Plan the search filters launch" });
  await expect(title).toBeVisible();
  await expect(page.getByText("@devtool", { exact: true }).first()).toBeVisible();
  await expect(page).toHaveURL(/\/chats\/\d+$/);

  // And a reload shows the same conversation with the message
  await page.reload();
  await expect(title).toBeVisible();
  await expect(message(page, "Plan the search filters launch")).toBeVisible();
  await expect(page).toHaveURL(/\/chats\/\d+$/);

  // And Conversations lists "Plan the search filters launch" above the other two
  await backButton(page).click();
  await expect(chatList(page).getByRole("heading")).toHaveText(["Plan the search filters launch", "Deploy alerts runbook", "Ship search filters"]);
});

scenario("On a phone back returns from a conversation to Conversations", { tag: ["@browser", "@phone"] }, async ({ server, page, context }) => {
  // Given the owner opened a conversation from the Conversations list on a phone
  const u = await uiWorld({ server, page, context });
  const conv = await createConversation(u.w.owner, { participants: ["devtool"], title: "Ship search filters" });
  await page.goto(`${u.w.srv.origin}/chats`);
  await chatRow(page, "Ship search filters").getByRole("link").click();
  await expect(page).toHaveURL(`${u.w.srv.origin}/chats/${conv}`);
  await expect(mainNav(page)).toBeHidden();

  // When the owner taps the back button
  await backButton(page).click();

  // Then the Conversations list shows
  await expect(page).toHaveURL(`${u.w.srv.origin}/chats`);
  await expect(chatList(page)).toBeVisible();
  await expect(mainNav(page).getByRole("link", { name: "Conversations" })).toHaveAttribute("aria-current", "page");

  // When the owner opens the conversation again and uses the browser back
  await chatRow(page, "Ship search filters").getByRole("link").click();
  await expect(page).toHaveURL(`${u.w.srv.origin}/chats/${conv}`);
  await page.goBack();

  // Then the Conversations list shows
  await expect(page).toHaveURL(`${u.w.srv.origin}/chats`);
  await expect(chatList(page)).toBeVisible();
});

scenario("On a phone the owner starts a conversation with an agent and sees its reply", { tag: ["@browser", "@phone"] }, async ({ server, page, context }) => {
  // Given "devtool" runs "convoz watch --json"
  const u = await uiWorld({ server, page, context });
  const watch = startWatch(u.w.box, u.sessions.devtool!.sid);
  try {
    await page.goto(`${u.w.srv.origin}/chats`);

    // When the owner taps "New conversation", types "@", picks "devtool" and sends "Is the build green?"
    await newChat(page).click();
    await chooseAgent(page, "devtool");
    await composer(page).fill(FIRST);
    await sendButton(page).click();

    // Then the message shows with the name "You" and an avatar on the left
    const mine = message(page, FIRST);
    await expect(mine).toBeVisible();
    await expect(mine).toContainText("You");
    const m = await box(mine);
    expect(m.x).toBeLessThanOrEqual(24);
    expect(m.width).toBeGreaterThan(VIEW.width * 0.8);
    expect(await hasBubble(mine)).toBe(false);

    // And the watch stream prints one JSON line with "Is the build green?" within 3 seconds
    const [line] = await watchLines(watch, 1, 3_000);
    expect(line!.body).toBe(FIRST);
    await page.evaluate(() => ((window as any).__kept = 1));

    // When "devtool" runs "convoz post" in that conversation with "Yes, all 11 checks pass"
    await agentPosts(u, "devtool", line!.conversation_id, "Yes, all 11 checks pass");

    // Then the reply shows on the left within 3 seconds with no reload
    const reply = message(page, "Yes, all 11 checks pass");
    await expect(reply).toBeVisible({ timeout: 3_000 });
    const r = await box(reply);
    expect(r.x).toBeLessThanOrEqual(24);
    expect(r.width).toBeGreaterThan(VIEW.width * 0.8);
    expect(await hasBubble(reply)).toBe(false);
    await expect(reply).toContainText("@devtool");
    expect(await page.evaluate(() => (window as any).__kept)).toBe(1);

    // And the Conversations list shows the conversation with no unread dot
    await backButton(page).click();
    await expect(chatRow(page, FIRST)).toBeVisible();
    await expect(unreadDot(chatRow(page, FIRST))).toHaveCount(0);
  } finally {
    watch.stop();
  }
});

scenario("On a phone a working agent shows a note until it replies", { tag: ["@browser", "@phone"] }, async ({ server, page, context }) => {
  // Given "devtool" runs "convoz watch --json" and the owner has a chat with "devtool" open on a phone
  const u = await uiWorld({ server, page, context });
  const conv = await createConversation(u.w.owner, { participants: ["devtool"], title: "Ship search filters" });
  const watch = startWatch(u.w.box, u.sessions.devtool!.sid);
  try {
    await page.goto(`${u.w.srv.origin}/chats/${conv}`);
    await expect(workingNote(page)).toHaveCount(0);

    // When the owner sends "Is the build green?"
    await composer(page).fill(FIRST);
    await sendButton(page).click();

    // Then the chat shows "@devtool is replying…" within 3 seconds
    await expect(workingNote(page)).toHaveText("@devtool is replying…", { timeout: 3_000 });

    // When "devtool" runs "convoz post" in that chat with "Yes"
    await agentPosts(u, "devtool", conv, "Yes");

    // Then the note is gone and the reply shows
    await expect(message(page, "Yes")).toBeVisible({ timeout: 3_000 });
    await expect(workingNote(page)).toHaveCount(0);
  } finally {
    watch.stop();
  }
});

scenario("The owner sees when an agent has seen a message", { tag: ["@browser"] }, async ({ server, page, context }) => {
  // Given "devtool" runs "convoz watch --json" and the owner has a conversation with "devtool" open
  const u = await uiWorld({ server, page, context });
  const conv = await createConversation(u.w.owner, { participants: ["devtool"], title: "Ship search filters" });
  const watch = startWatch(u.w.box, u.sessions.devtool!.sid);
  try {
    await page.goto(`${u.w.srv.origin}/chats/${conv}`);
    await expect(composer(page)).toBeVisible();

    // When the owner sends "Is the build green?"
    await composer(page).fill(FIRST);
    await sendButton(page).click();
    await watchLines(watch, 1, 3_000);

    // Then the message shows "Seen by @devtool" within 3 seconds
    await expect(message(page, FIRST).getByText("Seen by @devtool")).toBeVisible({ timeout: 3_000 });

    // When the owner reloads the page
    await page.reload();

    // Then the message still shows "Seen by @devtool"
    await expect(message(page, FIRST).getByText("Seen by @devtool")).toBeVisible();
  } finally {
    watch.stop();
  }
});

scenario("Replying clears when the agent posts", { tag: ["@browser"] }, async ({ server, page, context }) => {
  // Given the owner has a conversation with "devtool" and "docs" open
  const u = await uiWorld({ server, page, context }, { live: ["devtool", "docs"] });
  const conv = await createConversation(u.w.owner, { participants: ["devtool", "docs"], title: "Ship search filters" });
  await page.goto(`${u.w.srv.origin}/chats/${conv}`);
  await expect(messageLog(page)).toBeVisible();

  // When "devtool" and "docs" run "convoz typing" in that conversation
  for (const handle of ["devtool", "docs"]) {
    const typing = await convoz(u.w.box, u.sessions[handle]!.sid, ["typing", String(conv)]);
    expect(typing.code, typing.stderr).toBe(0);
  }

  // Then the conversation shows "@devtool and @docs are replying…" within 3 seconds
  await expect(workingNote(page)).toHaveText("@devtool and @docs are replying…", { timeout: 3_000 });

  // When "devtool" runs "convoz post" in that conversation with "Yes"
  await agentPosts(u, "devtool", conv, "Yes");

  // Then the conversation shows "@docs is replying…" and the reply shows
  await expect(message(page, "Yes")).toBeVisible({ timeout: 3_000 });
  await expect(workingNote(page)).toHaveText("@docs is replying…");
});

scenario("A card in Now shows who has seen and who is replying", { tag: ["@browser"] }, async ({ server, page, context }) => {
  // Given "devtool" asked a question in a conversation and runs "convoz watch --json"
  const u = await uiWorld({ server, page, context });
  const conv = await createConversation(u.w.owner, { participants: ["devtool"], title: "Ship search filters" });
  await agentAsks(u.w.srv, u.sessions.devtool!.lease, conv);
  const watch = startWatch(u.w.box, u.sessions.devtool!.sid);
  try {
    await openNow(page, u.w.srv);
    await expect(askCard(page)).toBeVisible();
    await streamOpen(page);

    // When the owner sends "Take your time" in that conversation
    await ownerSays(u.w.owner, conv, "Take your time");
    const [line] = await watchLines(watch, 1, 3_000);

    // Then the card in Now shows "Seen by @devtool" and "@devtool is replying…" within 3 seconds
    const seen = page.getByText("Seen by @devtool");
    await expect(seen).toBeVisible({ timeout: 3_000 });
    await expect(workingNote(page)).toHaveText("@devtool is replying…");

    // When "devtool" runs "convoz ack" without a reply
    const ack = await convoz(u.w.box, u.sessions.devtool!.sid, ["ack", `${line!.item_id}:${line!.claim_token}`]);
    expect(ack.code).toBe(0);

    // Then the card in Now still shows "Seen by @devtool" and no replying note
    await expect(workingNote(page)).toHaveCount(0, { timeout: 3_000 });
    await expect(seen).toBeVisible();
  } finally {
    watch.stop();
  }
});

scenario("On a phone the working note goes away when the agent finishes without a reply", { tag: ["@browser", "@phone"] }, async ({ server, page, context }) => {
  // Given "devtool" runs "convoz watch --json" and the owner has a chat with "devtool" open on a phone
  const u = await uiWorld({ server, page, context });
  const conv = await createConversation(u.w.owner, { participants: ["devtool"], title: "Ship search filters" });
  const watch = startWatch(u.w.box, u.sessions.devtool!.sid);
  try {
    await page.goto(`${u.w.srv.origin}/chats/${conv}`);

    // When the owner sends "Is the build green?" and "devtool" runs "convoz ack" without a reply
    await composer(page).fill(FIRST);
    await sendButton(page).click();
    const [line] = await watchLines(watch, 1, 3_000);
    await expect(workingNote(page)).toBeVisible({ timeout: 3_000 });
    const ack = await convoz(u.w.box, u.sessions.devtool!.sid, ["ack", `${line!.item_id}:${line!.claim_token}`]);
    expect(ack.code).toBe(0);

    // Then the chat shows no working note
    await expect(workingNote(page)).toHaveCount(0);
  } finally {
    watch.stop();
  }
});

scenario("On a phone the working note goes away when its time runs out", { tag: ["@browser", "@phone"] }, async ({ server, page, context }) => {
  // Given the owner has a chat open on a phone and "devtool" is shown as working for 2 seconds
  const u = await uiWorld({ server, page, context });
  const conv = await createConversation(u.w.owner, { participants: ["devtool"], title: "Ship search filters" });
  await page.goto(`${u.w.srv.origin}/chats/${conv}`);
  await expect(composer(page)).toBeVisible();
  await pushFrame(page, "agent.working", { identity_id: 1, handle: "devtool", conversation_id: conv, working: true, until: Date.now() + 2_000 });
  await expect(workingNote(page)).toHaveText("@devtool is replying…");

  // When 2 seconds pass with no reply
  // Then the chat shows no working note
  await expect(workingNote(page)).toHaveCount(0, { timeout: 4_000 });
});

scenario("On a phone an unread conversation shows a dot until opened", { tag: ["@browser", "@phone"] }, async ({ server, page, context }) => {
  // Given the owner is on the Conversations list on a phone
  const u = await uiWorld({ server, page, context });
  const conv = await createConversation(u.w.owner, { participants: ["devtool"], title: "Ship search filters" });
  await page.goto(`${u.w.srv.origin}/chats`);
  const row = chatRow(page, "Ship search filters");
  await expect(row).toBeVisible();
  await expect(unreadDot(row)).toHaveCount(0);

  // When "devtool" posts "Done" in conversation 41
  await agentPosts(u, "devtool", conv, "Done");

  // Then conversation 41 shows an unread dot and "Done" as its preview within 3 seconds
  await expect(unreadDot(row)).toBeVisible({ timeout: 3_000 });
  await expect(row).toContainText("devtool: Done");
  await expect.poll(() => isBold(row.getByRole("heading"))).toBe(true);

  // When the owner opens conversation 41 and goes back to Conversations
  await row.getByRole("link").click();
  await expect(message(page, "Done")).toBeVisible();
  await backButton(page).click();

  // Then conversation 41 has no unread dot
  await expect(unreadDot(chatRow(page, "Ship search filters"))).toHaveCount(0);
  await expect.poll(() => isBold(chatRow(page, "Ship search filters").getByRole("heading"))).toBe(false);
  await page.reload();
  await expect(chatRow(page, "Ship search filters")).toBeVisible();
  await expect(unreadDot(chatRow(page, "Ship search filters"))).toHaveCount(0);
  await expect.poll(() => unreadOf(u.w.owner, conv)).toBe(0);
});

scenario("On a phone Conversations shows plain previews, and the composer names the agent", { tag: ["@browser", "@phone"] }, async ({ server, page, context }) => {
  // Given "devtool" replied in one chat with markdown and the owner wrote in another chat with "docs"
  const u = await uiWorld({ server, page, context });
  const first = await createConversation(u.w.owner, { participants: ["devtool"], title: "Ship search filters" });
  const second = await createConversation(u.w.owner, { participants: ["docs"], title: "Write the runbook" });
  await ownerSays(u.w.owner, second, "Please draft it");
  await agentPosts(u, "devtool", first, "**Done**: see [the docs](https://example.com) and `make test`\n\n```\nmake test\n```");

  // When the owner opens Conversations
  await page.goto(`${u.w.srv.origin}/chats`);

  // Then the preview is plain text: no markers, the link as its text and the code block as "code"
  const row = chatRow(page, "Ship search filters");
  await expect(row.getByText("devtool: Done: see the docs and make test code", { exact: true })).toBeVisible();

  // And the message box is named after the agent
  await row.getByRole("link").click();
  await expect(composer(page)).toHaveAccessibleName("Message @devtool");
});

scenario("On a phone a conversation that does not exist shows a not-found page with a way back", { tag: ["@browser", "@phone"] }, async ({ server, page, context }) => {
  // Given the owner is signed in on a phone
  const u = await uiWorld({ server, page, context });

  // When the owner opens a conversation id that is missing, not a number, or not a whole number
  for (const id of ["99999", "abc", "-4"]) {
    const response = await page.goto(`${u.w.srv.origin}/chats/${id}`);

    // Then the page says the conversation was not found, in the console style, with a link back to Conversations
    expect(response?.status()).toBe(404);
    await expect(page.getByRole("heading", { level: 1, name: "Conversation not found" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Back to Conversations" })).toHaveAttribute("href", "/chats");
    await expect(mainNav(page)).toBeVisible();
  }
});

scenario("On a phone a conversation catches up after the connection comes back", { tag: ["@browser", "@phone"] }, async ({ server, page, context }) => {
  // Given the owner has conversation 41 open on a phone
  const u = await uiWorld({ server, page, context });
  const conv = await createConversation(u.w.owner, { participants: ["devtool"], title: "Ship search filters" });
  await page.goto(`${u.w.srv.origin}/chats/${conv}`);
  await expect(composer(page)).toBeVisible();

  // And the phone goes offline
  await context.setOffline(true);

  // When "devtool" posts "one", "two" and "three" in conversation 41
  for (const word of ["one", "two", "three"]) await agentPosts(u, "devtool", conv, word);

  // And the phone comes back online
  await context.setOffline(false);

  // Then conversation 41 shows "one", "two" and "three" once each, in that order, within 5 seconds
  await expect(messageLog(page).getByRole("article")).toHaveText([/\bone\b/, /\btwo\b/, /\bthree\b/], { timeout: 5_000 });
});

scenario("On a phone a conversation catches up when the app returns to the foreground", { tag: ["@browser", "@phone"] }, async ({ server, page, context }) => {
  // Given the owner has conversation 41 open on a phone
  const u = await uiWorld({ server, page, context });
  const conv = await createConversation(u.w.owner, { participants: ["devtool"], title: "Ship search filters" });
  await page.goto(`${u.w.srv.origin}/chats/${conv}`);
  await expect(composer(page)).toBeVisible();

  // And the phone stops the live connection without telling the page
  expect(await dropStreams(page)).toBeGreaterThan(0);

  // When "devtool" posts "four" in conversation 41 and the app returns to the foreground
  await agentPosts(u, "devtool", conv, "four");
  await appReturns(page);

  // Then conversation 41 shows "four" once within 5 seconds
  await expect(message(page, "four")).toBeVisible({ timeout: 5_000 });
  await expect(message(page, "four")).toHaveCount(1);
  await expect(messageLog(page).getByRole("article")).toHaveCount(1);
});

scenario("An agent message reaches the owner's open browser fast", { tag: ["@browser"] }, async ({ server, page, context }) => {
  // Given the owner has conversation 41 open
  const u = await uiWorld({ server, page, context });
  const conv = await createConversation(u.w.owner, { participants: ["devtool"], title: "Ship search filters" });
  await page.goto(`${u.w.srv.origin}/chats/${conv}`);
  await expect(composer(page)).toBeVisible();
  await page.evaluate(() => ((window as any).__kept = 1));

  // When "devtool" runs "convoz post 41 'Build is green'"
  const out = await agentPosts(u, "devtool", conv, "Build is green");

  // Then the message shows within 3 seconds with no reload
  await expect(message(page, "Build is green")).toBeVisible({ timeout: 3_000 });
  expect(await page.evaluate(() => (window as any).__kept)).toBe(1);

  // And "convoz post" printed the message id
  expect(out).toMatch(/^\d+\n$/);
});

scenario("A sent message shows at once and then confirms", { tag: ["@browser"] }, async ({ server, page, context }) => {
  // Given the owner has conversation 41 open and the server holds the next send
  const u = await uiWorld({ server, page, context });
  const conv = await createConversation(u.w.owner, { participants: ["devtool"], title: "Ship search filters" });
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  await page.route("**/api/conversations/*/messages", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    await gate;
    await route.continue();
  });
  await page.goto(`${u.w.srv.origin}/chats/${conv}`);

  // When the owner sends "on it" in conversation 41
  await composer(page).fill("on it");
  await sendButton(page).click();

  // Then the bubble shows at once as "sending"
  const bubble = message(page, "on it");
  await expect(bubble).toBeVisible();
  await expect(bubble).toContainText("sending");

  // And it shows as sent when the server confirms
  release();
  await expect(bubble).not.toContainText("sending");
  await expect(bubble).not.toContainText("failed");
  expect((await messagesOf(u.w.owner, conv)).map((m) => m.body)).toEqual(["on it"]);
});

scenario("On a phone the composer stays above the keyboard and grows to a limit", { tag: ["@browser", "@phone"] }, async ({ server, page, context }) => {
  // Given the owner has conversation 41 open on a phone (with a window.visualViewport the test can resize, as iOS Safari reports a keyboard)
  const u = await uiWorld({ server, page, context });
  const conv = await createConversation(u.w.owner, { participants: ["devtool"], title: "Ship search filters" });
  await page.addInitScript(() => {
    const real = window.visualViewport!;
    const fake = new EventTarget();
    const override: Record<string, number> = {};
    (window as any).__vv = override;
    for (const k of ["width", "height", "offsetTop", "offsetLeft", "pageTop", "pageLeft", "scale"]) {
      Object.defineProperty(fake, k, { get: () => (k in override ? override[k] : (real as any)[k]) });
    }
    real.addEventListener("resize", () => fake.dispatchEvent(new Event("resize")));
    real.addEventListener("scroll", () => fake.dispatchEvent(new Event("scroll")));
    Object.defineProperty(window, "visualViewport", { value: fake, configurable: true });
  });
  await page.goto(`${u.w.srv.origin}/chats/${conv}`);
  const form = page.getByRole("form", { name: "Composer" });
  await expect(composer(page)).toBeVisible();
  const bottomOf = async () => {
    const b = await box(form);
    return b.y + b.height;
  };
  // the prototype's composer floats 10 px above the bottom edge (safe-area padding on a phone with a home bar)
  expect(await bottomOf()).toBeGreaterThanOrEqual(VIEW.height - 10.5);
  expect(await bottomOf()).toBeLessThanOrEqual(VIEW.height + 0.5);
  const oneLine = (await box(composer(page))).height;
  expect(oneLine).toBeGreaterThanOrEqual(44);

  // When the keyboard opens and the owner types 12 lines
  await page.evaluate(() => {
    (window as any).__vv.height = 500;
    window.visualViewport!.dispatchEvent(new Event("resize"));
  });
  await composer(page).fill(["a", "b", "c"].join("\n"));
  const threeLines = (await box(composer(page))).height;
  await composer(page).fill(Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join("\n"));

  // Then the message box stays in view above the keyboard
  await expect.poll(bottomOf).toBeLessThanOrEqual(500.5);
  await expect.poll(bottomOf).toBeGreaterThanOrEqual(489);

  // And it grew to about 6 lines and then scrolls inside itself
  const twelve = await box(composer(page));
  expect(threeLines).toBeGreaterThan(oneLine + 20);
  expect(twelve.height).toBeLessThanOrEqual(200);
  expect(twelve.height).toBeGreaterThan(threeLines);
  expect(await composer(page).evaluate((e) => e.scrollHeight > e.clientHeight)).toBe(true);

  // And a layout viewport that shrinks (Android) keeps it in view too
  await page.evaluate(() => {
    for (const k of Object.keys((window as any).__vv)) delete (window as any).__vv[k];
    window.visualViewport!.dispatchEvent(new Event("resize"));
  });
  await page.setViewportSize({ width: 390, height: 480 });
  await expect.poll(bottomOf).toBeLessThanOrEqual(480.5);
  await expect.poll(bottomOf).toBeGreaterThanOrEqual(469);
});

scenario("On a phone Enter adds a line and Send sends", { tag: ["@browser", "@phone"] }, async ({ server, page, context }) => {
  // Given the owner has conversation 41 open on a phone
  const u = await uiWorld({ server, page, context });
  const conv = await createConversation(u.w.owner, { participants: ["devtool"], title: "Ship search filters" });
  await page.goto(`${u.w.srv.origin}/chats/${conv}`);

  // Then Send is disabled while the message box is empty
  await expect(sendButton(page)).toBeDisabled();
  await composer(page).fill("   ");
  await expect(sendButton(page)).toBeDisabled();
  await composer(page).fill("");

  // When the owner types "one", presses Enter and types "two"
  await composer(page).click();
  await page.keyboard.type("one");
  await page.keyboard.press("Enter");
  await page.keyboard.type("two");

  // Then the message box holds two lines and nothing is sent
  await expect(composer(page)).toHaveValue("one\ntwo");
  await expect(sendButton(page)).toBeEnabled();
  expect(await messagesOf(u.w.owner, conv)).toHaveLength(0);

  // When the owner taps Send
  await sendButton(page).click();

  // Then the chat shows one message with two lines
  const sent = message(page, "one");
  await expect(sent).toBeVisible();
  await expect(messageLog(page).getByRole("article")).toHaveCount(1);
  expect(await sent.evaluate((e) => (e as HTMLElement).innerText)).toContain("one\ntwo");
  expect((await messagesOf(u.w.owner, conv)).map((m) => m.body)).toEqual(["one\ntwo"]);
  await expect(composer(page)).toHaveValue("");
  await expect(sendButton(page)).toBeDisabled();
});

scenario("Enter sends on a desktop and adds a line on a phone", { tag: ["@browser"] }, async ({ server, page, context }, info) => {
  // Given the owner has conversation 41 open
  const u = await uiWorld({ server, page, context });
  const conv = await createConversation(u.w.owner, { participants: ["devtool"], title: "Ship search filters" });
  await page.goto(`${u.w.srv.origin}/chats/${conv}`);

  // When the owner types "one", adds a line the way the device does and types "two"
  // (the "mobile" project is a touch phone: Enter adds the line there; the "chromium" project is a desktop: Shift+Enter does)
  const phone = info.project.name === "mobile";
  await composer(page).click();
  await page.keyboard.type("one");
  await page.keyboard.press(phone ? "Enter" : "Shift+Enter");
  await page.keyboard.type("two");

  // Then the message box holds two lines and nothing is sent
  await expect(composer(page)).toHaveValue("one\ntwo");
  await expect(messageLog(page).getByRole("article")).toHaveCount(0);
  expect(await messagesOf(u.w.owner, conv)).toEqual([]);

  // When the owner sends the way the device does: Send on a phone, Enter on a desktop
  if (phone) await sendButton(page).click();
  else await page.keyboard.press("Enter");

  // Then the chat shows one message with two lines
  await expect(message(page, "one")).toBeVisible();
  await expect(messageLog(page).getByRole("article")).toHaveCount(1);
  expect((await messagesOf(u.w.owner, conv)).map((m) => m.body)).toEqual(["one\ntwo"]);
  await expect(composer(page)).toHaveValue("");
});

scenario("On a phone a failed send is retried once without a duplicate", { tag: ["@browser", "@phone"] }, async ({ server, page, context }) => {
  // Given the owner has conversation 41 open on a phone and the network drops the next send
  const u = await uiWorld({ server, page, context });
  const conv = await createConversation(u.w.owner, { participants: ["devtool"], title: "Ship search filters" });
  const tries: { client_id: string; body: string }[] = [];
  await page.route("**/api/conversations/*/messages", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    tries.push(route.request().postDataJSON());
    if (tries.length === 1) return route.abort("connectionfailed");
    await route.continue();
  });
  await page.goto(`${u.w.srv.origin}/chats/${conv}`);

  // When the owner sends "retry me" and then taps Retry
  await composer(page).fill("retry me");
  await sendButton(page).click();

  // Then the bubble first says "failed · retry"
  const bubble = message(page, "retry me");
  await expect(bubble).toContainText("failed · retry");
  await bubble.getByRole("button", { name: "Retry" }).click();
  await expect(bubble).not.toContainText("failed");
  await expect(bubble).not.toContainText("sending");

  // And conversation 41 holds "retry me" once
  expect(tries).toHaveLength(2);
  expect(tries[1]!.client_id).toBe(tries[0]!.client_id);
  await expect(message(page, "retry me")).toHaveCount(1);
  expect((await messagesOf(u.w.owner, conv)).map((m) => m.body)).toEqual(["retry me"]);
});

scenario("A new conversation goes to the top of the Conversations list", { tag: ["@browser"] }, async ({ server, page, context }) => {
  // Given conversations 41, 52 and 60 were created in that order with "devtool"
  const u = await uiWorld({ server, page, context });
  for (const title of ["Ship search filters", "Deploy alerts runbook", "Weekly usage"]) await createConversation(u.w.owner, { participants: ["devtool"], title });

  // Then the Conversations list shows 60, 52, 41 in that order
  await page.goto(`${u.w.srv.origin}/chats`);
  await expect(chatList(page).getByRole("heading")).toHaveText(["Weekly usage", "Deploy alerts runbook", "Ship search filters"]);
});

scenario("New activity never reorders the Conversations list", { tag: ["@browser"] }, async ({ server, page, context }) => {
  // Given the owner opened the Conversations list
  const u = await uiWorld({ server, page, context });
  const ids: number[] = [];
  for (const title of ["Ship search filters", "Deploy alerts runbook", "Weekly usage"]) ids.push(await createConversation(u.w.owner, { participants: ["devtool"], title }));
  await page.goto(`${u.w.srv.origin}/chats`);
  await expect(chatList(page).getByRole("heading")).toHaveCount(3);

  // When "devtool" posts in conversation 41
  await agentPosts(u, "devtool", ids[0]!, "Done");

  // Then the Conversations list still shows 60, 52, 41 in that order without a reload
  await expect(chatRow(page, "Ship search filters").getByText("devtool: Done")).toBeVisible({ timeout: 3_000 });
  await expect(chatList(page).getByRole("heading")).toHaveText(["Weekly usage", "Deploy alerts runbook", "Ship search filters"]);

  // And conversation 41 shows its new preview
  expect(await rowTitles(page)).toHaveLength(3);
});

scenario("On a phone Reorder mode moves a conversation and Done ends it", { tag: ["@browser", "@phone"] }, async ({ server, page, context }) => {
  // Given conversations 41, 52 and 60 were created in that order with "devtool"
  const u = await uiWorld({ server, page, context });
  for (const title of ["Ship search filters", "Deploy alerts runbook", "Weekly usage"]) await createConversation(u.w.owner, { participants: ["devtool"], title });
  await page.goto(`${u.w.srv.origin}/chats`);
  await expect(chatList(page).getByRole("heading")).toHaveText(["Weekly usage", "Deploy alerts runbook", "Ship search filters"]);

  // When the owner long presses conversation 41 and picks "Reorder…"
  await chatRow(page, "Ship search filters").dispatchEvent("contextmenu");
  await page.getByRole("menuitem", { name: "Reorder…" }).click();

  // Then every row shows a handle and the top bar shows "Done"
  await expect(page.getByRole("button", { name: /^Reorder .*Alt plus arrow keys move it\.$/ })).toHaveCount(3);
  await expect(page.getByRole("button", { name: "Done", exact: true })).toBeVisible();

  // When the owner moves conversation 41 up with the keyboard handle
  await page.getByRole("button", { name: "Reorder Ship search filters. Alt plus arrow keys move it." }).focus();
  await page.keyboard.press("Alt+ArrowUp");

  // Then the Conversations list shows 60, 41, 52 in that order
  await expect(chatList(page).getByRole("heading")).toHaveText(["Weekly usage", "Ship search filters", "Deploy alerts runbook"]);

  // When the owner taps "Done"
  await page.getByRole("button", { name: "Done", exact: true }).click();

  // Then the handles are gone and a reload shows 60, 41, 52
  await expect(page.getByRole("button", { name: /Alt plus arrow keys move it\.$/ })).toHaveCount(0);
  await page.reload();
  await expect(chatList(page).getByRole("heading")).toHaveText(["Weekly usage", "Ship search filters", "Deploy alerts runbook"]);
});

scenario("Unread conversations are bold with a count", { tag: ["@browser"] }, async ({ server, page, context }) => {
  // Given the owner has read every conversation
  const u = await uiWorld({ server, page, context });
  const ids: number[] = [];
  for (const title of ["Ship search filters", "Deploy alerts runbook", "Weekly usage"]) ids.push(await createConversation(u.w.owner, { participants: ["devtool"], title }));
  await page.goto(`${u.w.srv.origin}/chats`);
  const row = chatRow(page, "Deploy alerts runbook");
  await expect(row).toBeVisible();
  await expect.poll(() => isBold(row.getByRole("heading"))).toBe(false);

  // When "devtool" posts 3 messages in conversation 52
  for (const n of [1, 2, 3]) await agentPosts(u, "devtool", ids[1]!, `update ${n}`);

  // Then conversation 52 is bold with "3"
  await expect(row.getByText("3", { exact: true })).toBeVisible({ timeout: 3_000 });
  await expect.poll(() => isBold(row.getByRole("heading"))).toBe(true);
  await expect(unreadDot(chatRow(page, "Weekly usage"))).toHaveCount(0);

  // And opening conversation 52 clears the bold and the count
  await row.getByRole("link").click();
  await expect(message(page, "update 3")).toBeVisible();
  await backButton(page).click();
  await expect(chatRow(page, "Deploy alerts runbook").getByText("3", { exact: true })).toHaveCount(0);
  await expect.poll(() => isBold(chatRow(page, "Deploy alerts runbook").getByRole("heading"))).toBe(false);
});

scenario("On a phone a long conversation opens at its latest message", { tag: ["@browser", "@phone"] }, async ({ server, page, context }) => {
  // Given conversation 41 holds 60 messages
  const u = await uiWorld({ server, page, context });
  const conv = await createConversation(u.w.owner, { participants: ["devtool"], title: "Ship search filters" });
  for (let n = 1; n <= 60; n++) await ownerSays(u.w.owner, conv, `msg-${String(n).padStart(3, "0")} ${"words ".repeat(12)}`);

  // When the owner opens conversation 41 on a phone
  await page.goto(`${u.w.srv.origin}/chats/${conv}`);

  // Then the latest message is in view
  await expect(message(page, "msg-060")).toBeInViewport();
  await expect.poll(() => fromBottom(messageLog(page))).toBeLessThanOrEqual(2);
  await expect(message(page, "msg-001")).not.toBeInViewport();
});

scenario("On a phone a new reply while reading older messages shows a pill instead of jumping", { tag: ["@browser", "@phone"] }, async ({ server, page, context }) => {
  // Given the owner scrolled up in a long conversation 41 on a phone
  const u = await uiWorld({ server, page, context });
  const conv = await createConversation(u.w.owner, { participants: ["devtool"], title: "Ship search filters" });
  for (let n = 1; n <= 40; n++) await ownerSays(u.w.owner, conv, `msg-${String(n).padStart(3, "0")} ${"words ".repeat(12)}`);
  await page.goto(`${u.w.srv.origin}/chats/${conv}`);
  const log = messageLog(page);
  await expect.poll(() => fromBottom(log)).toBeLessThanOrEqual(2);
  await log.evaluate((e) => (e.scrollTop = 0));
  await expect(newMessagePill(page)).toHaveCount(0);
  const before = await log.evaluate((e) => e.scrollTop);

  // When "devtool" posts "Fresh news" in conversation 41
  await agentPosts(u, "devtool", conv, "Fresh news");

  // Then the page does not move and a "New message ↓" pill shows
  await expect(newMessagePill(page)).toBeVisible({ timeout: 3_000 });
  expect(Math.abs((await log.evaluate((e) => e.scrollTop)) - before)).toBeLessThanOrEqual(2);
  await expect(message(page, "Fresh news")).not.toBeInViewport();

  // When the owner taps the pill
  await newMessagePill(page).click();

  // Then "Fresh news" is in view and the pill is gone
  await expect(message(page, "Fresh news")).toBeInViewport();
  await expect(newMessagePill(page)).toHaveCount(0);
  expect(await fromBottom(log)).toBeLessThanOrEqual(2);
});

scenario("On a phone an agent reply shows paragraphs, code and links safely", { tag: ["@browser", "@phone"] }, async ({ server, page, context }) => {
  // Given the owner has conversation 41 open on a phone
  const u = await uiWorld({ server, page, context });
  const conv = await createConversation(u.w.owner, { participants: ["devtool"], title: "Ship\u202e search filters" });
  page.on("dialog", (d) => {
    throw new Error(`a dialog opened: ${d.message()}`);
  });
  await page.goto(`${u.w.srv.origin}/chats/${conv}`);
  await expect(composer(page)).toBeVisible();

  // When "devtool" posts a reply with two paragraphs, a code block, a link and an image tag written as text
  const tag = '<img src=x onerror="window.__pwned=1">';
  await agentPosts(u, "devtool", conv, ["First paragraph with `inline code`.", `Second paragraph with a [docs link](https://example.com/docs), [a bad one](javascript:alert(1)) and ${tag} as text. Pay at [bank.example.com](https://evil.example/login) or [our site](https://example.com/ok), not exe\u202etxt\u200b.`, "```js\nconst a = 1 < 2;\n```"].join("\n\n"));

  // Then the reply shows two paragraphs, a code block and a link that opens a new tab safely
  const reply = message(page, "First paragraph");
  await expect(reply).toBeVisible({ timeout: 3_000 });
  await expect(reply.locator("p")).toHaveCount(2);
  await expect(reply.locator("pre code")).toHaveText("const a = 1 < 2;");
  await expect(reply.locator("p code")).toHaveText("inline code");
  const link = reply.getByRole("link", { name: "docs link" });
  await expect(link).toHaveAttribute("href", "https://example.com/docs");
  await expect(link).toHaveAttribute("target", "_blank");
  await expect(link).toHaveAttribute("rel", /noopener/);
  await expect(reply.locator('a[href^="javascript:"]')).toHaveCount(0);

  // And the image tag shows as text and no image is made
  await expect(reply).toContainText(tag);
  await expect(messageLog(page).locator("img")).toHaveCount(0);
  await expect(messageLog(page).locator("[onerror]")).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__pwned)).toBeUndefined();

  // And the owner's own message with an image tag shows as text too
  await composer(page).fill(`${tag} **plain**`);
  await sendButton(page).click();
  const mine = message(page, "**plain**");
  await expect(mine).toContainText(`${tag} **plain**`);
  await expect(messageLog(page).locator("img")).toHaveCount(0);
  await expect(mine.locator("strong")).toHaveCount(0);

  // And a link whose label is blank shows the real site, and a link whose label is more than plain words of one script and is not the real site shows the real site after it, and without the lookalike list from the server any label that is not plain ASCII shows the real site after it
  await expect(reply.getByRole("link", { name: /bank\.example\.com/ })).toHaveText("bank.example.com (evil.example)");
  await expect(reply.getByRole("link", { name: "our site" })).toHaveText("our site");
  // The server allows 5 links in a message, so the probes go in batches of 5 or fewer; each batch is checked by its own heading.
  const probeLabels = ["paypal.com ", "paypal.com\u00a0", "paypal\u3002com", "paypal\uff0ecom", "support@paypal.com", "Sign in to paypal.com", "paypal.c\u034fom", "10.0.0.1", "localhost", "intranet", "evil.example", "Sign in", "here", "192.168.1.1/login", "localhost/x", "intranet/login", "Go to 192.168.1.1 now", "paypal. com", "paypal\u200a.\u200acom", "paypal\u2009.\u2009com", "paypal\u00b7com", "paypal\u06d4com", "paypal\u0589com", "paypal\u30fbcom", "paypal.c\u2800om", "PR #23", "paypal\u02d9com", "paypal\u00b8com", "paypal\ua4f8com", "paypal\u1427com", "paypal\u119ecom", "paypal\u4e36com", "https\u02d0\u30ce\u30cepaypal\ua4f8com", "paypal.com evil.example", "Log in to paypal.com via evil.example", "\u3164", "\u043f\u0440\u0438\u0432\u0435\u0442", "\u6587\u6863", "docs", "paypal\ua78fcom", "\u767e\u5ea6\u4e36\u4e2d\u56fd", "\ub124\uc774\ubc84\u119e\ud55c\uad6d", "paypal\u01c3com", "paypal\u0294com", "paypal\u0903com", "paypa\u0140com", "PAYPA\u013fCOM", "paypal\u318dcom", "\ub124\uc774\ubc84\u318d\ud55c\uad6d", "paypal\u0338com", "paypal\u20d2com", "\u0628\u0646\u0643\u0887\u0645\u0635\u0631", "paypal\u1abecom", "\u043f\u0440\u0438\u0432\u0435\u0442\u0489"];
  const probeLinks = [...probeLabels.map((l) => `[${l}](https://evil.example/x)`), ...["[docs](https://github.com/a/b)", "https://\u0430pple.com/login", "https://evil.test\\@paypal.com", "https://paypal.com@evil.test", "http://a.b/(x)", "http://a.b/x)"]];
  const probeShown: string[] = ["paypal.com (evil.example)", "paypal.com (evil.example)", "paypal\u3002com (evil.example)", "paypal\uff0ecom (evil.example)", "support@paypal.com (evil.example)", "Sign in to paypal.com (evil.example)", "paypal.c\u034fom (evil.example)", "10.0.0.1 (evil.example)", "localhost", "intranet", "evil.example", "Sign in", "here", "192.168.1.1/login (evil.example)", "localhost/x (evil.example)", "intranet/login (evil.example)", "Go to 192.168.1.1 now (evil.example)", "paypal. com (evil.example)", "paypal\u200a.\u200acom (evil.example)", "paypal\u2009.\u2009com (evil.example)", "paypal\u00b7com (evil.example)", "paypal\u06d4com (evil.example)", "paypal\u0589com (evil.example)", "paypal\u30fbcom (evil.example)", "paypal.c\u2800om (evil.example)", "PR #23 (evil.example)", "paypal\u02d9com (evil.example)", "paypal\u00b8com (evil.example)", "paypal\ua4f8com (evil.example)", "paypal\u1427com (evil.example)", "paypal\u119ecom (evil.example)", "paypal\u4e36com (evil.example)", "https\u02d0\u30ce\u30cepaypal\ua4f8com (evil.example)", "paypal.com evil.example (evil.example)", "Log in to paypal.com via evil.example (evil.example)", "evil.example", "\u043f\u0440\u0438\u0432\u0435\u0442", "\u6587\u6863", "docs", "paypal\ua78fcom (evil.example)", "\u767e\u5ea6\u4e36\u4e2d\u56fd (evil.example)", "\ub124\uc774\ubc84\u119e\ud55c\uad6d (evil.example)", "paypal\u01c3com (evil.example)", "paypal\u0294com (evil.example)", "paypal\u0903com (evil.example)", "paypa\u0140com (evil.example)", "PAYPA\u013fCOM (evil.example)", "paypal\u318dcom (evil.example)", "\ub124\uc774\ubc84\u318d\ud55c\uad6d (evil.example)", "paypal\u0338com (evil.example)", "paypal\u20d2com (evil.example)", "\u0628\u0646\u0643\u0887\u0645\u0635\u0631 (evil.example)", "paypal\u1abecom (evil.example)", "\u043f\u0440\u0438\u0432\u0435\u0442\u0489 (evil.example)", "docs", "https://xn--pple-43d.com/login", "evil.test", "evil.test", "http://a.b/(x)", "http://a.b/x"];
  expect(probeShown).toHaveLength(probeLinks.length);
  const probeBatches: [number, number][] = [];
  for (let end = probeLinks.length; end > 0; end -= 5) probeBatches.unshift([Math.max(0, end - 5), end]); // from the end, so the last batch holds the http://a.b links
  const probeHead = (n: number) => `Probes ${String(n + 1).padStart(2, "0")}`;
  for (const [n, [from, to]] of probeBatches.entries()) await agentPosts(u, "devtool", conv, [probeHead(n), ...probeLinks.slice(from, to)].join("\n"));
  for (const [n, [from, to]] of probeBatches.entries()) await expect(message(page, probeHead(n)).locator("a")).toHaveText(probeShown.slice(from, to), { timeout: 3_000 });
  const probes = message(page, probeHead(probeBatches.length - 1));
  await expect(probes.locator("a", { hasText: /^http:\/\/a\.b\/\(x\)$/ })).toHaveAttribute("href", "http://a.b/(x)");
  await expect(probes.locator("a", { hasText: /^http:\/\/a\.b\/x$/ })).toHaveAttribute("href", "http://a.b/x");
  const noList = await loadRenderMarkdown(u.w.srv.origin, { withLookalikes: false });
  expect(JSON.stringify(noList("[\u767e\u5ea6\u4e36\u4e2d\u56fd](https://evil.example/x)"))).toContain("(evil.example)");
  expect(JSON.stringify(noList("[docs](https://evil.example/x)"))).not.toContain("(evil.example)");
  expect(JSON.stringify(noList("[\u6587\u6863](https://evil.example/x)"))).toContain("(evil.example)");
  expect(JSON.stringify((await loadRenderMarkdown(u.w.srv.origin))("[\u6587\u6863](https://evil.example/x)"))).not.toContain("(evil.example)");

  // And hidden text-direction marks in a title or a message are not shown
  await expect(reply).toContainText("not exetxt.");
  expect(await reply.textContent()).not.toMatch(/[\u202e\u200b]/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Ship search filters");
  await expect(page).toHaveTitle("Ship search filters - Convoz");

  // And a hundred messages of 16384 characters each of "[", "[a](", "[a](x", "[a]([a](", "**", a backtick or "http://" and 2040 dots and "a", and ten of "[a](http://a.b) ", "[é1](http://a.b) ", "http://a:b " or "[a](http://[) ", render, each shape in under half a second
  // (timed in Node on the real chat.js code: Chromium's regex engine falls back to a linear one, so a browser timing cannot fail)
  const render = await loadRenderMarkdown(u.w.srv.origin);
  const floods = ["[a](http://a.b) ", "[é1](http://a.b) ", "http://a:b ", "[a](http://[) "];
  const shapes = ["[", "[a](", "[a](x", "[a]([a](", "**".repeat(8192), "`".repeat(16384), ...floods, "http://" + ".".repeat(2040) + "a"];
  for (const unit of shapes) {
    const body = unit.repeat(Math.ceil(16384 / unit.length)).slice(0, 16384);
    // a link flood is over a thousand real links per message: linear but heavy, so ten messages
    const count = floods.includes(unit) ? 10 : 100;
    // Warm up, then take the fastest of 5 trials, each timed in this process's CPU time: a slow renderer burns CPU in every trial, while a busy box only makes the process wait for a core, so this measures the renderer and not the machine's load.
    render(body);
    let fastest = Infinity;
    for (let trial = 0; trial < 5; trial++) {
      const began = process.cpuUsage();
      for (let i = 0; i < count; i++) render(body);
      const used = process.cpuUsage(began);
      fastest = Math.min(fastest, (used.user + used.system) / 1000);
    }
    expect(fastest, JSON.stringify(unit.slice(0, 12))).toBeLessThan(500);
  }
  // And a message shows at most 200 links, the rest as plain text, and failed link attempts count toward the 200
  const links = (node: unknown): number => {
    if (!node || typeof node !== "object") return 0;
    if (Array.isArray(node)) return node.reduce((n: number, kid) => n + links(kid), 0);
    const { tag, kids } = node as { tag?: string; kids?: unknown[] };
    return (tag === "a" ? 1 : 0) + links(kids ?? []);
  };

  const texts = (node: unknown): string => {
    if (typeof node === "string") return node;
    if (!node || typeof node !== "object") return "";
    if (Array.isArray(node)) return node.map(texts).join("");
    const { tag, kids } = node as { tag?: string; kids?: unknown[] };
    return tag === "a" ? "" : texts(kids ?? []);
  };
  const capped = render(Array.from({ length: 201 }, (_, i) => `[l${i + 1}](http://a.b) `).join(""));
  expect(links(capped)).toBe(200);
  expect(texts(capped)).toContain("[l201](http://a.b)");
  expect(texts(capped)).not.toContain("[l200]");
  expect(links(render("[a](http://a.b) ".repeat(1024)))).toBe(200);
  // failed attempts spend the same budget as good ones, so the link after 200 unparsable ones is plain text
  expect(links(render("[a](http://[) ".repeat(200) + "[ok](http://a.b)"))).toBe(0);
});

scenario("On a phone the conversation pages fit a 320 px screen with large tap targets", { tag: ["@browser", "@phone"] }, async ({ server, page, context }) => {
  // Given the owner has a long conversation with long words and a wide code line
  const u = await uiWorld({ server, page, context });
  const conv = await createConversation(u.w.owner, { participants: ["devtool"], title: "A very long title that keeps going and going so the app bar has to cope with it" });
  await ownerSays(u.w.owner, conv, `${"x".repeat(240)} https://example.com/${"path/".repeat(30)}`);
  await agentPosts(u, "devtool", conv, ["```\n" + "wide_code_line_".repeat(20) + "\n```", "A paragraph " + "y".repeat(240)].join("\n\n"));

  // When the owner opens Conversations, New conversation and the conversation at 320 px and at 390 px
  const wide: string[] = [];
  const small: string[] = [];
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    for (const [name, path] of [["Conversations", "/chats"], ["New conversation", "/chats/new"], ["Conversation", `/chats/${conv}`]] as const) {
      await page.goto(`${u.w.srv.origin}${path}`);
      await page.waitForLoadState("networkidle");
      // the page is the chat UI, not an error page: its own heading shows
      await expect(page.getByRole("heading", { level: 1, name: name === "Conversation" ? /A very long title/ : name, exact: false })).toBeVisible();
      if ((await overflowX(page)) > 0) wide.push(`${name} at ${width}px`);
      small.push(...(await smallChatTargets(page)).map((s) => `${name} at ${width}px: ${s}`));
    }
  }

  // Then no page scrolls sideways and every button, link and field is at least 44 px tall
  expect(wide).toEqual([]);
  expect(small).toEqual([]);
});

scenario("On a phone the conversation pages look right in dark and light", { tag: ["@browser", "@phone"] }, async ({ server, page, context }, info) => {
  // Given the owner has a conversation with messages from both sides
  const u = await uiWorld({ server, page, context });
  const conv = await createConversation(u.w.owner, { participants: ["devtool"], title: "Ship search filters" });
  await ownerSays(u.w.owner, conv, FIRST);
  await agentPosts(u, "devtool", conv, "Yes, **all 11** checks pass.\n\n```\nmake test\n```");
  await createConversation(u.w.owner, { participants: ["docs"], title: "Weekly usage" });

  // When the owner opens Conversations, New conversation and the conversation in dark and in light
  const looks: string[] = [];
  for (const scheme of ["dark", "light"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    for (const [name, path] of [["chats", "/chats"], ["new-chat", "/chats/new"], ["conversation", `/chats/${conv}`]] as const) {
      await page.goto(`${u.w.srv.origin}${path}`);
      await page.waitForLoadState("networkidle");
      await expect(page.getByRole("heading").first()).toBeVisible();
      await info.attach(`${name} (${scheme})`, { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });
      looks.push(`${name} ${scheme} ${(await backgroundLuminance(page)) < 0.25 ? "dark" : (await backgroundLuminance(page)) > 0.75 ? "light" : "mid"}`);
    }
  }

  // Then the dark pages are dark and the light pages are light
  expect(looks).toEqual(["chats dark dark", "new-chat dark dark", "conversation dark dark", "chats light light", "new-chat light light", "conversation light light"]);
});

scenario("Agent replies use the full width", { tag: ["@browser"] }, async ({ server, page, context }) => {
  // Given the owner has conversation 41 open
  const u = await uiWorld({ server, page, context });
  const conv = await createConversation(u.w.owner, { participants: ["devtool"], title: "Ship search filters" });

  // And the owner sent "Is the build green?" and "devtool" replied "Yes, all 11 checks pass"
  await ownerSays(u.w.owner, conv, FIRST);
  await agentPosts(u, "devtool", conv, "Yes, all 11 checks pass");
  await page.goto(`${u.w.srv.origin}/chats/${conv}`);
  const reply = message(page, "Yes, all 11 checks pass");
  const mine = message(page, FIRST);
  await expect(reply).toBeVisible();
  await expect(mine).toBeVisible();

  // Then the reply has no bubble and fills the message column
  const log = await box(messageLog(page));
  const column = Math.min(760, log.width);
  const article = await box(reply);
  const text = await box(reply.getByText("Yes, all 11 checks pass"));
  expect(await hasBubble(reply.getByText("Yes, all 11 checks pass"))).toBe(false);
  expect(Math.abs(article.width - column)).toBeLessThanOrEqual(1);
  expect(Math.abs(text.width - (column - 24))).toBeLessThanOrEqual(1);

  // And the message column is the screen with 12 px gutters on a phone and a centred 760 px column on a desktop
  expect(Math.abs(text.x - (log.x + (log.width - column) / 2 + 12))).toBeLessThanOrEqual(1);

  // And the owner's message is a compact bubble on the right, at most 85% wide, with its time above it
  const bubbleText = mine.getByText(FIRST);
  expect(await hasBubble(bubbleText)).toBe(true);
  const bubble = await box(bubbleText);
  const mineArticle = await box(mine);
  expect(Math.abs(bubble.x + bubble.width - (mineArticle.x + mineArticle.width - 12))).toBeLessThanOrEqual(1);
  expect(bubble.width).toBeLessThanOrEqual(column * 0.85 + 1);
  expect(bubble.width).toBeLessThan(column * 0.85);
  const time = await box(mine.locator("time"));
  expect(time.y + time.height).toBeLessThanOrEqual(bubble.y + 1);
});

scenario("The header shrinks while typing on a phone", { tag: ["@browser", "@phone"] }, async ({ server, page, context }) => {
  // Given the owner has conversation 41 open on a phone
  const u = await uiWorld({ server, page, context });
  const conv = await createConversation(u.w.owner, { participants: ["devtool"], title: "Ship search filters" });
  await page.goto(`${u.w.srv.origin}/chats/${conv}`);
  const header = page.locator("header").first();
  const details = page.getByRole("button", { name: "Show details" });
  await expect(composer(page)).toBeVisible();
  const full = await box(header);
  expect(full.height).toBeGreaterThanOrEqual(52);
  await expect(details).toBeVisible();

  // When the keyboard opens on the message box (the layout viewport shrinks, as on Android with resizes-content)
  await composer(page).click();
  await page.setViewportSize({ width: 390, height: 480 });

  // Then the header is one 36 px line with Back and the title
  await expect.poll(async () => (await box(header)).height).toBe(36);
  await expect(backButton(page)).toBeVisible();
  await expect(page.getByRole("heading", { level: 1, name: "Ship search filters" })).toBeVisible();
  await expect(details).toBeHidden();
  expect((await box(backButton(page))).height).toBe(36);

  // And the message box grows from one line to at most four
  const oneLine = (await box(composer(page))).height;
  await composer(page).fill(Array.from({ length: 9 }, (_, i) => `line ${i + 1}`).join("\n"));
  const nine = (await box(composer(page))).height;
  expect(nine).toBeGreaterThan(oneLine + 60);
  expect(nine).toBeLessThanOrEqual(oneLine + 72 + 0.5);
  expect(await composer(page).evaluate((e) => e.scrollHeight > e.clientHeight)).toBe(true);
  const form = await box(page.getByRole("form", { name: "Composer" }));
  expect(form.y + form.height).toBeLessThanOrEqual(480.5);
  expect(form.y + form.height).toBeGreaterThanOrEqual(469);

  // And the message box asks for a new line on Return, capitals at sentence starts, spelling and autocorrect
  await expect(composer(page)).toHaveAttribute("enterkeyhint", "enter");
  await expect(composer(page)).toHaveAttribute("autocapitalize", "sentences");
  await expect(composer(page)).toHaveAttribute("autocorrect", "on");
  await expect(composer(page)).toHaveAttribute("spellcheck", "true");

  // When the keyboard closes
  await composer(page).blur();
  await page.setViewportSize({ width: 390, height: 844 });

  // Then the full header is back
  await expect.poll(async () => (await box(header)).height).toBe(full.height);
  await expect(details).toBeVisible();
});
