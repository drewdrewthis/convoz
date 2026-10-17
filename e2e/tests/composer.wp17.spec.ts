import { composer, message, messageLog, sendButton } from "../lib/chat-ui.ts";
import { createConversation, messagesOf } from "../lib/chat.ts";
import { expect, scenario } from "../lib/scenario.ts";
import { pageLink, world } from "../lib/wp17.ts";

/*
 * COMPOSER (WP17): the offline outbox. The browser's link is the page's own CDP emulation, so a second page of the same context
 * stays online and is the "second browser". A send waits as "sending"; it goes out again with its client id when the link is back.
 */

scenario("An offline send is replayed once when back online", { tag: ["@browser", "@I-24"] }, async ({ server, page, context }, info) => {
  info.setTimeout(120_000);
  const u = await world({ server, page, context });
  const conv = await createConversation(u.w.owner, { participants: ["devtool"], title: "Ship search filters" });
  const second = await context.newPage();
  await second.goto(`${u.w.srv.origin}/chats/${conv}`);
  await expect(composer(second)).toBeVisible({ timeout: 30_000 });
  await page.goto(`${u.w.srv.origin}/chats/${conv}`);
  await expect(composer(page)).toBeVisible({ timeout: 30_000 });

  // Given the browser is offline
  const link = await pageLink(context, page);
  await link(true);

  // When the owner sends "first" and then "second"
  for (const text of ["first", "second"]) {
    await composer(page).fill(text);
    await sendButton(page).click();
    await expect(message(page, text)).toContainText("sending");
  }
  expect(await messagesOf(u.w.owner, conv)).toEqual([]);

  // And the browser comes back online
  await link(false);

  // Then conversation 41 shows "first" and then "second", each once, on a second browser
  await expect(messageLog(second).getByRole("article")).toHaveText([/first$/, /second$/], { timeout: 60_000 });
  expect((await messagesOf(u.w.owner, conv)).map((m) => m.body)).toEqual(["first", "second"]);
  await expect(messageLog(page).getByText("sending", { exact: true })).toHaveCount(0, { timeout: 30_000 });
  await expect(messageLog(page).getByRole("article")).toHaveCount(2);
});
