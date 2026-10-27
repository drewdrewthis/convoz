import type { Page } from "@playwright/test";
import { agentChoice, composer, message, sendButton } from "../lib/chat-ui.ts";
import { openThread, threadWorld, ROOT_TEXT } from "../lib/threads-wp5.ts";
import { createConversation, messagesOf, ownerSays, peekFor } from "../lib/chat.ts";
import { revokeAgentKey } from "../lib/machines.ts";
import { must } from "../lib/owner.ts";
import { expect, scenario } from "../lib/scenario.ts";
import { asAgent, browserWorld, handlesOf, idsOf, seedDb, startSession, viewOf } from "../lib/wp3.ts";

/*
 * COMPOSER (WP5): specs/features/composer.feature (Enter, mentions) and specs/contracts/composer.feature (a failed send).
 *
 * DEVICE SETTING "enter to send": localStorage key "convoz.device.enter_to_send" = "auto" | "on" | "off" (absent = auto), read at each
 *   key press so a change applies at once (design §11: device settings live on the device). "on" sends on Enter, "off" adds a line, and
 *   "auto" sends when the device has a hardware keyboard and adds a line when it has only a touch keyboard. The app decides that with
 *   matchMedia("(pointer: coarse), (max-width: 600px)"): a match is "only a touch keyboard". Shift+Enter always adds a line.
 * THE @ LIST in a conversation: typing "@" and some letters opens the list "Agents" of the enabled agents whose handle starts with them
 *   (a disabled agent is never in it); a button "@docs ..." picks one and writes "@docs " in place of what was typed. The server brings
 *   the agent in when the person sends the message (I-18); a mention in code, a quote or a link adds nobody.
 * A FAILED SEND shows "failed · retry" (retry is a button) and a send in flight shows "sending" (design §9); Retry sends the same client id again.
 */

const KEY = "convoz.device.enter_to_send";
const TITLE = "Ship search filters";

/** Make the page report whether the device has only a touch keyboard, whatever the browser really is: `window.__touchOnly`. */
async function emulateKeyboard(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const real = window.matchMedia.bind(window);
    window.matchMedia = (query: string) => {
      const list = real(query);
      if (!/pointer:\s*coarse/.test(query)) return list;
      return new Proxy(list, {
        get(target, key) {
          if (key === "matches" && (window as unknown as { __touchOnly?: boolean }).__touchOnly !== undefined) return (window as unknown as { __touchOnly: boolean }).__touchOnly;
          const v = Reflect.get(target, key);
          return typeof v === "function" ? v.bind(target) : v;
        },
      });
    };
  });
}

/** The textbox of the open conversation, whatever its name says ("Message @devtool", or "Message" with several agents). */
const box = (page: Page) => page.getByRole("textbox", { name: /^Message/ });

// ---- Rule: Sending is instant and safe to repeat -------------------------------------------------------------

scenario("Enter sends or adds a new line", { tag: ["@browser"] }, async ({ server, page, context }) => {
  // Background
  const w = await browserWorld({ server, page, context }, { agents: ["devtool", "docs"] });
  const conv = await createConversation(w.owner, { participants: ["devtool"], title: TITLE });
  await emulateKeyboard(page);
  await page.goto(`${w.srv.origin}/chats/${conv}`);
  await expect(composer(page)).toBeVisible();

  const rows = [
    { setting: "auto", touchOnly: false, keyboard: "has a hardware keyboard", sends: true },
    { setting: "auto", touchOnly: true, keyboard: "has only a touch keyboard", sends: false },
    { setting: "off", touchOnly: false, keyboard: "has a hardware keyboard", sends: false },
    { setting: "on", touchOnly: true, keyboard: "has only a touch keyboard", sends: true },
  ];
  let sent = 0;
  for (const [i, row] of rows.entries()) {
    const label = `${row.setting} / ${row.keyboard}`;
    // Given the device setting "enter to send" is "<setting>" and the device <keyboard>
    await page.evaluate(([key, setting, touch]) => {
      localStorage.setItem(key as string, setting as string);
      (window as unknown as { __touchOnly: boolean }).__touchOnly = touch as boolean;
    }, [KEY, row.setting, row.touchOnly] as const);

    // When the owner presses Enter in the composer
    const text = `row ${i + 1}`;
    await composer(page).fill(text);
    await page.keyboard.press("Enter");

    // Then the composer <result>
    if (row.sends) {
      await expect(message(page, text), label).toBeVisible();
      await expect(composer(page), label).toHaveValue("");
      sent++;
    } else {
      await expect(composer(page), label).toHaveValue(`${text}\n`);
      await composer(page).fill("");
    }
    expect((await messagesOf(w.owner, conv)).map((m) => m.body), label).toHaveLength(sent);
  }
  expect((await messagesOf(w.owner, conv)).map((m) => m.body)).toEqual(["row 1", "row 4"]);
});

scenario("A failed send can be retried", { tag: ["@browser"] }, async ({ server, page, context }) => {
  // Background
  const w = await browserWorld({ server, page, context }, { agents: ["devtool", "docs"] });
  const conv = await createConversation(w.owner, { participants: ["devtool"], title: TITLE });

  // Given the server refuses the next send with 500 five times
  const tries: { client_id: string; body: string }[] = [];
  await page.route("**/api/conversations/*/messages", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    tries.push(route.request().postDataJSON());
    if (tries.length <= 5) return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: { code: "internal", message: "refused" } }) });
    await route.continue();
  });
  await page.goto(`${w.srv.origin}/chats/${conv}`);

  // When the owner sends "retry me"
  await composer(page).fill("retry me");
  await sendButton(page).click();

  // Then the bubble shows "failed · retry" 
  const bubble = message(page, "retry me");
  await expect(bubble).toContainText("failed · retry");
  await expect(bubble.getByRole("button", { name: "Retry" })).toBeVisible();
  expect(await messagesOf(w.owner, conv)).toEqual([]);

  // And tapping retry delivers it once
  for (let refused = 2; refused <= 5; refused++) {
    await bubble.getByRole("button", { name: "Retry" }).click();
    await expect.poll(() => tries.length).toBe(refused);
    await expect(bubble).toContainText("failed · retry");
  }
  await bubble.getByRole("button", { name: "Retry" }).click();
  await expect(bubble).not.toContainText("failed");
  await expect(bubble).not.toContainText("sending");
  expect(tries).toHaveLength(6);
  expect(new Set(tries.map((t) => t.client_id)).size).toBe(1); // every try is the same send
  expect((await messagesOf(w.owner, conv)).map((m) => m.body)).toEqual(["retry me"]);
  await expect(message(page, "retry me")).toHaveCount(1);
});

// ---- Rule: Mentions bring agents in (I-18) -------------------------------------------------------------------

scenario("Picking an agent from the mention list adds it", { tag: ["@browser", "@I-18", "@AC-13"] }, async ({ server, page, context, dataDir }) => {
  // Background
  const w = await browserWorld({ server, page, context }, { agents: ["devtool", "docs"], live: ["docs"], plaintext: true });
  const conv = await createConversation(w.owner, { participants: ["devtool"], title: TITLE });
  await ownerSays(w.owner, conv, "an earlier note");
  await page.goto(`${w.srv.origin}/chats/${conv}`);
  await expect(message(page, "an earlier note")).toBeVisible();

  // When the owner types "@do" in conversation 41 and picks "docs" from the list
  await composer(page).fill("@do");
  await expect(agentChoice(page, "devtool")).toHaveCount(0); // only what starts with "do"
  await agentChoice(page, "docs").click();
  await expect(box(page)).toHaveValue("@docs ");

  // And sends "@docs please write the release note"
  await page.keyboard.type("please write the release note");
  await expect(box(page)).toHaveValue("@docs please write the release note");
  await sendButton(page).click();
  await expect(message(page, "@docs please write the release note")).toBeVisible();
  await expect.poll(async () => (await messagesOf(w.owner, conv)).length).toBe(3); // the message and the "@drew added @docs" system line (74212e5); the bubble shows before the server holds them

  // Then "docs" is a participant of conversation 41 from that message
  const sent = (await messagesOf(w.owner, conv)).find((m) => m.body === "@docs please write the release note")!;
  expect(sent.body).toBe("@docs please write the release note");
  expect(handlesOf(await viewOf(w.owner, conv))).toContain("docs");
  const docsRead = await asAgent(w.srv, w.sessions.docs!.lease, "GET", `/api/conversations/${conv}/messages`);
  expect(docsRead.json().messages.map((m: { body: string }) => m.body)).toEqual(["an earlier note", "@docs please write the release note", "@drew added @docs"]);
  const floor = seedDb(dataDir, (db) =>
    Number(
      (db.prepare("SELECT p.joined_message_id AS n FROM participants p JOIN identities i ON i.id = p.identity_id WHERE p.conversation_id = ? AND i.handle = 'docs'").get(conv) as { n: number }).n,
    ),
  );
  expect(floor).toBe(0); // it sees the whole history, the note before the mention too

  // And "docs" gets a mention item
  const items = await peekFor(w.box, w.sessions.docs!.sid, conv);
  expect(items.map((i) => i.reason)).toEqual(["mention"]);
  expect(items[0]!.message.id).toBe(sent.id);
});

const FUZZY_CREW = ["devtool", "dash", "dashboard", "lw-dashboards", "dataset-host"];

scenario("Letters typed after the at sign find a handle by order, not only by its start", { tag: ["@browser", "@I-18"] }, async ({ server, page, context }) => {
  // Background
  const w = await browserWorld({ server, page, context }, { agents: FUZZY_CREW });
  const conv = await createConversation(w.owner, { participants: ["devtool"], title: TITLE });
  await page.goto(`${w.srv.origin}/chats/${conv}`);
  await expect(composer(page)).toBeVisible();

  // When the owner types "@lwd" in conversation 41
  await composer(page).fill("@lwd");

  // Then the mention list offers "lw-dashboards" and nothing else
  await expect(agentChoice(page, "lw-dashboards")).toBeVisible();
  await expect(page.getByRole("list", { name: "Agents" }).getByRole("button")).toHaveCount(1);
});

scenario("The mention list puts the closest handle first", { tag: ["@browser", "@I-18"] }, async ({ server, page, context }) => {
  // Background
  const w = await browserWorld({ server, page, context }, { agents: FUZZY_CREW });
  const conv = await createConversation(w.owner, { participants: ["devtool"], title: TITLE });
  await page.goto(`${w.srv.origin}/chats/${conv}`);
  await expect(composer(page)).toBeVisible();

  // When the owner types "@dash" in conversation 41
  await composer(page).fill("@dash");

  // Then the mention list shows "dash", then "dashboard", then "lw-dashboards", then "dataset-host"
  const handles = page.getByRole("list", { name: "Agents" }).locator(".handle");
  await expect(handles).toHaveText(["dash", "dashboard", "lw-dashboards", "dataset-host"]);
});

scenario("A disabled agent is not offered and not added", { tag: ["@browser", "@I-18"] }, async ({ server, page, context }) => {
  // Background, and Given the owner disabled "release-bot"
  const w = await browserWorld(
    { server, page, context },
    {
      agents: ["devtool", "docs", "release-bot"],
      beforeSignIn: async (world) => {
        const row = (await idsOf(world.owner))["release-bot"]!;
        must(await revokeAgentKey(world.owner, row), "disable release-bot");
      },
    },
  );
  const conv = await createConversation(w.owner, { participants: ["devtool"], title: TITLE });
  await page.goto(`${w.srv.origin}/chats/${conv}`);
  await expect(composer(page)).toBeVisible();

  // Then the mention list did not offer "release-bot"
  await composer(page).fill("@");
  await expect(agentChoice(page, "docs")).toBeVisible(); // the list is open, and has the enabled agents
  await expect(agentChoice(page, "release-bot")).toHaveCount(0);
  await composer(page).fill("@release");
  await expect(agentChoice(page, "release-bot")).toHaveCount(0);
  await expect(page.getByRole("list", { name: "Agents" }).getByRole("button")).toHaveCount(0);

  // When the owner sends "@release-bot ship it" in conversation 41
  await composer(page).fill("@release-bot ship it");
  await sendButton(page).click();
  await expect(message(page, "@release-bot ship it")).toBeVisible();
  await expect.poll(async () => (await messagesOf(w.owner, conv)).length).toBe(1); // the bubble shows before the server holds the message

  // And "release-bot" is not a participant
  expect(handlesOf(await viewOf(w.owner, conv))).not.toContain("release-bot");
  expect((await messagesOf(w.owner, conv)).map((m) => m.body)).toEqual(["@release-bot ship it"]);
});

scenario("A mention inside code does not add an agent", { tag: ["@browser", "@I-18"] }, async ({ server, page, context }) => {
  // Background
  const w = await browserWorld({ server, page, context }, { agents: ["devtool", "docs"] });
  const conv = await createConversation(w.owner, { participants: ["devtool"], title: TITLE });
  await page.goto(`${w.srv.origin}/chats/${conv}`);

  // Control: outside code a mention opens the list
  await composer(page).fill("run @do");
  await expect(agentChoice(page, "docs")).toBeVisible();

  // When the owner sends "run `@docs build`" in conversation 41
  await composer(page).fill("run `@docs build`");
  await expect(page.getByRole("list", { name: "Agents" }).getByRole("button")).toHaveCount(0); // no list opens inside code
  await sendButton(page).click();
  await expect(message(page, "run")).toBeVisible();
  await expect.poll(async () => (await messagesOf(w.owner, conv)).length).toBe(1); // the bubble shows before the server holds the message

  // Then "docs" is not a participant
  expect((await messagesOf(w.owner, conv)).map((m) => m.body)).toEqual(["run `@docs build`"]);
  expect(handlesOf(await viewOf(w.owner, conv))).not.toContain("docs");
});

// Owner ruling 2026-10-18 (iPhone, Chrome): "I think you should also disable zoom, tighten the input component to save space, and get
// rid of the padding under 'also send to conversation'"
scenario("The phone composer is compact and the page does not zoom", { tag: ["@browser", "@phone"] }, async ({ server, page, context }) => {
  // Given conversation 41 is open with a thread on its first message
  const t = await threadWorld({ server, page, context }, { browser: true });

  // When the owner opens conversation 41 on a 390 by 844 phone with the keyboard closed
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${t.w.srv.origin}/chats/${t.conv}`);
  await expect(message(page, ROOT_TEXT)).toBeVisible();

  // Then the viewport has maximum-scale=1
  await expect(page.locator('meta[name="viewport"]')).toHaveAttribute("content", /maximum-scale=1(?![\d.])/);
  // And every text box has a font size of at least 16 px
  const smallText = () =>
    page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>('textarea, select, [contenteditable]:not([contenteditable="false"]), input:not([type="checkbox"]):not([type="radio"]):not([type="file"]):not([type="hidden"]):not([type="range"])')]
        .filter((e) => e.getBoundingClientRect().width > 0)
        .map((e) => `${e.tagName.toLowerCase()} ${parseFloat(getComputedStyle(e).fontSize)}px`)
        .filter((s) => parseFloat(s.split(" ")[1]!) < 16),
    );
  expect(await smallText()).toEqual([]);
  expect(await page.getByRole("textbox", { name: /^Message/ }).evaluate((e) => parseFloat(getComputedStyle(e).fontSize))).toBeGreaterThanOrEqual(16);
  // And the empty composer is at most 56 px tall
  const height = (await page.locator(".compose").boundingBox())!.height;
  console.log(`MEASURE composer block ${height}px`);
  expect(height).toBeLessThanOrEqual(56);

  // When the owner opens the thread
  await openThread(page, ROOT_TEXT);

  // Then its reply box is 16 px too
  expect(await smallText()).toEqual([]);
});

// ---- Rule: The @ mention and the paperclip work on a phone with the keyboard up ------------------------------------

/** A visualViewport the test can shrink, as iOS Safari reports a keyboard, and a 34 px home-bar inset like an iPhone's. */
async function phoneKeyboard(page: Page): Promise<(open: boolean) => Promise<void>> {
  await page.addInitScript(() => {
    const real = window.visualViewport!;
    const fake = new EventTarget();
    const override: Record<string, number> = {};
    (window as unknown as { __vv: Record<string, number> }).__vv = override;
    for (const k of ["width", "height", "offsetTop", "offsetLeft", "pageTop", "pageLeft", "scale"]) Object.defineProperty(fake, k, { get: () => (k in override ? override[k] : (real as never)[k]) });
    real.addEventListener("resize", () => fake.dispatchEvent(new Event("resize")));
    real.addEventListener("scroll", () => fake.dispatchEvent(new Event("scroll")));
    Object.defineProperty(window, "visualViewport", { value: fake, configurable: true });
  });
  return (open) =>
    page.evaluate((o) => {
      const vv = (window as unknown as { __vv: Record<string, number> }).__vv;
      if (o) vv.height = 500;
      else for (const k of Object.keys(vv)) delete vv[k];
      window.visualViewport!.dispatchEvent(new Event("resize"));
    }, open);
}

/** Open conversation 41 on the phone, tap the message box, and raise the keyboard. */
async function phoneChat(fx: Parameters<typeof browserWorld>[0]) {
  const keyboard = await phoneKeyboard(fx.page);
  const w = await browserWorld(fx, { agents: ["devtool", "claude-convoz"] });
  const conv = await createConversation(w.owner, { participants: ["devtool"], title: TITLE });
  await fx.page.goto(`${w.srv.origin}/chats/${conv}`);
  await expect(box(fx.page)).toBeVisible();
  await fx.page.evaluate(() => document.documentElement.style.setProperty("--bottom", "34px"));
  await box(fx.page).tap();
  await keyboard(true);
  return { w, conv, keyboard };
}

const caret = (page: Page) => box(page).evaluate((e: HTMLTextAreaElement) => [e.selectionStart, e.selectionEnd]);

// Owner report 2026-10-18 (iPhone, Chrome): "Also the @ mention is weird. I doesn't stay in the input - some weird behavior there"
scenario("The @ text stays as typed while the list is open on a phone", { tag: ["@browser", "@phone", "@I-18"] }, async ({ server, page, context }) => {
  // Given conversation 41 is open on a phone with the keyboard up
  const { w, conv } = await phoneChat({ server, page, context });

  // When the owner types "@cl" key by key
  await page.keyboard.type("@cl", { delay: 60 });

  // Then the message box shows "@cl" and the list offers "claude-convoz"
  await expect(box(page)).toHaveValue("@cl");
  await expect(agentChoice(page, "claude-convoz")).toBeVisible();
  await page.waitForTimeout(400); // a late reset would show now
  await expect(box(page)).toHaveValue("@cl");
  await expect(box(page)).toBeFocused();

  // And the same holds when the keyboard sends the letters as one insert or as a composition
  await box(page).fill("");
  await page.keyboard.insertText("@c");
  const ime = await page.context().newCDPSession(page);
  await ime.send("Input.imeSetComposition", { text: "l", selectionStart: 1, selectionEnd: 1 });
  await expect(box(page)).toHaveValue("@cl");
  await expect(agentChoice(page, "claude-convoz")).toBeVisible();
  await ime.send("Input.insertText", { text: "l" });
  await expect(box(page)).toHaveValue("@cl");
  expect(await messagesOf(w.owner, conv)).toEqual([]);
});

scenario("Tapping a name leaves the handle in the box on a phone", { tag: ["@browser", "@phone", "@I-18"] }, async ({ server, page, context }) => {
  // Given conversation 41 is open on a phone with the keyboard up and "@cl" typed
  const { keyboard } = await phoneChat({ server, page, context });
  await page.keyboard.type("@cl", { delay: 60 });
  const row = agentChoice(page, "claude-convoz");
  await expect(row).toBeVisible();

  // When the owner taps "claude-convoz" in the list
  const at = (await row.boundingBox())!;
  await page.touchscreen.tap(at.x + at.width / 2, at.y + at.height / 2);

  // Then the message box holds "@claude-convoz " with the caret after it
  await expect(box(page)).toHaveValue("@claude-convoz ");
  expect(await caret(page)).toEqual([15, 15]);
  await expect(box(page)).toBeFocused();
  await expect(agentChoice(page, "claude-convoz")).toHaveCount(0);

  // And it survives the keyboard closing and opening
  await keyboard(false);
  await keyboard(true);
  await page.waitForTimeout(400);
  await expect(box(page)).toHaveValue("@claude-convoz ");
  expect(await caret(page)).toEqual([15, 15]);
});

scenario("A mention sent from a phone is in the message", { tag: ["@browser", "@phone", "@I-18"] }, async ({ server, page, context }) => {
  // Given conversation 41 is open on a phone with the keyboard up and "@claude-convoz " picked by a tap
  const { w, conv } = await phoneChat({ server, page, context });
  await page.keyboard.type("@cl", { delay: 60 });
  const at = (await agentChoice(page, "claude-convoz").boundingBox())!;
  await page.touchscreen.tap(at.x + at.width / 2, at.y + at.height / 2);
  await expect(box(page)).toHaveValue("@claude-convoz ");

  // When the owner types "hi" and taps Send
  await page.keyboard.type("hi", { delay: 60 });
  const send = (await sendButton(page).boundingBox())!;
  await page.touchscreen.tap(send.x + send.width / 2, send.y + send.height / 2);

  // Then the message is "@claude-convoz hi" and "claude-convoz" is in the conversation
  await expect.poll(async () => (await messagesOf(w.owner, conv)).map((m) => m.body)).toEqual(["@claude-convoz hi", "@drew added @claude-convoz"]);
  await expect(message(page, "@claude-convoz hi")).toBeVisible();
  expect(handlesOf(await viewOf(w.owner, conv))).toContain("claude-convoz");
});

// Owner report 2026-10-18 (iPhone, Chrome): "once you start typing in the input the paperclip stops working"
scenario("The paperclip works after the owner types on a phone", { tag: ["@browser", "@phone"] }, async ({ server, page, context }) => {
  // Given conversation 41 is open on a phone with the keyboard up
  await phoneChat({ server, page, context });
  // Listening starts before the typing: the browser needs a moment to start handing file choosers to the test, and a tap that lands first
  // opens a chooser nobody sees (the test's race, not the page's).
  const chooser = page.waitForEvent("filechooser", { timeout: 20_000 });

  // When the owner types "hello" and taps the paperclip once
  await page.keyboard.type("hello", { delay: 60 });
  const clip = page.getByRole("button", { name: "Attach a file" });
  const at = (await clip.boundingBox())!;
  await page.touchscreen.tap(at.x + at.width / 2, at.y + at.height / 2);

  // Then the file chooser opens
  expect((await chooser).isMultiple()).toBe(true);

  // And the message box still holds "hello"
  await expect(box(page)).toHaveValue("hello");
});
