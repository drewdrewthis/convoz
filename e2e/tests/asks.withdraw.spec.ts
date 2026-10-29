import { appReturns, dropStreams, streamOpen, uiWorld } from "../lib/chat-ui.ts";
import { agentAsks, askCard, openNow } from "../lib/asks.ts";
import { convoz, createConversation } from "../lib/chat.ts";
import { expect, scenario } from "../lib/scenario.ts";

/*
 * WITHDRAWN ASKS: an ask the agent withdraws leaves Now and shows closed on its card, live, and also after the stream was cut
 * while it was withdrawn (drew, conv 37 msg 928: "the ask still seems open on the convoz ui").
 */

scenario("A withdrawn ask leaves Now and its card shows closed at once", { tag: ["@browser"] }, async ({ server, page, context }, info) => {
  info.setTimeout(90_000);
  // Given an open ask of "devtool", and the owner has the conversation and Now open in two pages
  const u = await uiWorld({ server, page, context }, { agents: ["devtool"], live: ["devtool"] });
  const conv = await createConversation(u.w.owner, { title: "Ship search filters", participants: ["devtool"] });
  const id = await agentAsks(u.w.srv, u.sessions.devtool!.lease, conv);
  await page.goto(`${u.w.srv.origin}/chats/${conv}`);
  await expect(askCard(page).getByRole("button", { name: "Okay", exact: true })).toBeVisible();
  const now = await context.newPage();
  await openNow(now, u.w.srv);
  await expect(askCard(now)).toBeVisible();
  await streamOpen(page);
  await streamOpen(now);

  // When "devtool" withdraws the ask
  const ran = await convoz(u.w.box, u.sessions.devtool!.sid, ["ask", "withdraw", String(id)]);
  expect({ code: ran.code, stderr: ran.stderr }).toEqual({ code: 0, stderr: "" });

  // Then Now no longer lists it and the card in the conversation shows closed, with no reload
  await expect(askCard(now)).toHaveCount(0, { timeout: 4_000 });
  await expect(askCard(page)).toContainText("Closed", { timeout: 4_000 });
  await expect(askCard(page).getByRole("button", { name: "Okay", exact: true })).toHaveCount(0);
});

scenario("After the stream was cut, an ask withdrawn meanwhile shows closed with no reload", { tag: ["@browser"] }, async ({ server, page, context }, info) => {
  info.setTimeout(90_000);
  // Given an open ask of "devtool" on the page of its conversation
  const u = await uiWorld({ server, page, context }, { agents: ["devtool"], live: ["devtool"] });
  const conv = await createConversation(u.w.owner, { title: "Ship search filters", participants: ["devtool"] });
  const id = await agentAsks(u.w.srv, u.sessions.devtool!.lease, conv);
  await page.goto(`${u.w.srv.origin}/chats/${conv}`);
  await expect(askCard(page).getByRole("button", { name: "Okay", exact: true })).toBeVisible();
  await streamOpen(page);

  // And the stream is cut
  expect(await dropStreams(page)).toBeGreaterThan(0);

  // When "devtool" withdraws the ask and the page reconnects
  const ran = await convoz(u.w.box, u.sessions.devtool!.sid, ["ask", "withdraw", String(id)]);
  expect({ code: ran.code, stderr: ran.stderr }).toEqual({ code: 0, stderr: "" });
  await appReturns(page);

  // Then the card shows closed with no reload
  await expect(askCard(page)).toContainText("Closed", { timeout: 5_000 });
  await expect(askCard(page).getByRole("button", { name: "Okay", exact: true })).toHaveCount(0);
});
