import type { Page } from "@playwright/test";
import { agentChoice, composer, message, sendButton } from "../lib/chat-ui.ts";
import { createConversation, messagesOf, ownerSays, peekFor } from "../lib/chat.ts";
import { stepped } from "../lib/machines.ts";
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

  // Then "docs" is a participant of conversation 41 from that message
  const sent = (await messagesOf(w.owner, conv)).at(-1)!;
  expect(sent.body).toBe("@docs please write the release note");
  expect(handlesOf(await viewOf(w.owner, conv))).toContain("docs");
  const docsRead = await asAgent(w.srv, w.sessions.docs!.lease, "GET", `/api/conversations/${conv}/messages`);
  expect(docsRead.json().messages.map((m: { body: string }) => m.body)).toEqual(["@docs please write the release note"]);
  const floor = seedDb(dataDir, (db) =>
    Number(
      (db.prepare("SELECT p.joined_message_id AS n FROM participants p JOIN identities i ON i.id = p.identity_id WHERE p.conversation_id = ? AND i.handle = 'docs'").get(conv) as { n: number }).n,
    ),
  );
  expect(floor).toBe(sent.id - 1); // it sees the message that brought it in, and nothing before

  // And "docs" gets a mention item
  const items = await peekFor(w.box, w.sessions.docs!.sid, conv);
  expect(items.map((i) => i.reason)).toEqual(["mention"]);
  expect(items[0]!.message.id).toBe(sent.id);
});

scenario("A disabled agent is not offered and not added", { tag: ["@browser", "@I-18"] }, async ({ server, page, context }) => {
  // Background, and Given the owner disabled "release-bot"
  const w = await browserWorld(
    { server, page, context },
    {
      agents: ["devtool", "docs", "release-bot"],
      beforeSignIn: async (world) => {
        const row = (await idsOf(world.owner))["release-bot"]!;
        must(await stepped(world.owner, "POST", `/api/identities/${row}/disable`, {}, "identity.disable", row), "disable release-bot");
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

  // Then "docs" is not a participant
  expect((await messagesOf(w.owner, conv)).map((m) => m.body)).toEqual(["run `@docs build`"]);
  expect(handlesOf(await viewOf(w.owner, conv))).not.toContain("docs");
});
