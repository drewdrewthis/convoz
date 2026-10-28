import { uiWorld } from "../lib/chat-ui.ts";
import { createConversation } from "../lib/chat.ts";
import { agentAsks, askCard } from "../lib/asks.ts";
import { send } from "../lib/http.ts";
import { putPlan } from "../lib/plan.ts";
import { must } from "../lib/owner.ts";
import { expect, scenario } from "../lib/scenario.ts";

/*
 * A BURST OF SYSTEM LINES (prod logged 32 identical GET /api/conversations/9/messages in one second): a line the conversation says
 * about itself makes the page read the asks it holds again, once per line. The bindings of the rule "A burst of lines the conversation
 * says about itself reads the conversation again once, not once per line" of specs/features/asks.feature.
 */

scenario("Ten system lines in one tick read a conversation at most twice", { tag: ["@browser"] }, async ({ server, page, context }, info) => {
  info.setTimeout(90_000);
  // Given "devtool" asked in conversation 41 and the owner has the ask card open
  const u = await uiWorld({ server, page, context }, { agents: ["devtool"], live: ["devtool"] });
  const conv = await createConversation(u.w.owner, { title: "Ship search filters", participants: ["devtool"] });
  await agentAsks(u.w.srv, u.sessions.devtool!.lease, conv);
  await page.goto(`${u.w.srv.origin}/chats/${conv}`);
  await expect(askCard(page).first()).toBeVisible();
  const reads = { detail: 0, messages: 0, plans: 0 };
  const count = (re: RegExp, key: keyof typeof reads) =>
    page.route(re, (route) => {
      if (route.request().method() === "GET") reads[key]++;
      return route.continue();
    });
  await count(new RegExp(`/api/conversations/${conv}(\\?|$)`), "detail");
  await count(new RegExp(`/api/conversations/${conv}/messages(\\?|$)`), "messages");
  await count(new RegExp(`/api/plans\\?conversation=${conv}(&|$)`), "plans");
  const none = () => Object.assign(reads, { detail: 0, messages: 0, plans: 0 });
  await page.waitForTimeout(2000); // the reads of opening the page (the first delta, the newest page) are not the burst
  none();
  const line = (l: Record<string, unknown>) => send(u.w.srv.target, "POST", "/__test/system-line", { json: { conversation: conv, ...l } }).then((r) => must(r, "write a system line"));
  const burst = (l: Record<string, unknown>) => Promise.all(Array.from({ length: 10 }, () => line(l)));

  // When ten system lines arrive in conversation 41 in one tick
  await burst({ t: "member.added", identity: "devtool", by: "drew", via: "add" });
  await expect(page.getByRole("note")).toHaveCount(10);
  await page.waitForTimeout(1500);

  // Then the page reads the conversation, its messages and its plans at most twice each
  expect(reads.detail).toBeLessThanOrEqual(2);
  expect(reads.messages).toBeLessThanOrEqual(2);
  expect(reads.plans).toBeLessThanOrEqual(2);

  // And one resume of the app makes the same reads at most twice each
  none();
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await page.waitForTimeout(1500);
  expect(reads.detail).toBeLessThanOrEqual(2);
  expect(reads.messages).toBeLessThanOrEqual(2);
  expect(reads.plans).toBeLessThanOrEqual(2);

  // And lines that only quote a plan change make it read no messages
  none();
  for (let i = 1; i <= 10; i++) must(await putPlan(u.w.srv, u.sessions.devtool!.lease, conv, { done: [`step ${i}`] }), "update the plan");
  await expect(page.locator('[data-t="plan.changed"]')).toHaveCount(10);
  await page.waitForTimeout(1500);
  expect(reads.messages).toBe(0);
});
