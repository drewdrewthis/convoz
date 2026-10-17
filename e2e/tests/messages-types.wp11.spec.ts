import { agentPost } from "../lib/chat.ts";
import { appsWorld, ownerResult, pageOf, pickerResult, postApp, validApp } from "../lib/apps-wp11.ts";
import { must } from "../lib/owner.ts";
import { expect, scenario } from "../lib/scenario.ts";

/*
 * MESSAGES AND THEIR TYPES, the app part (WP11): the binding of the contract scenario in specs/contracts/messages-types.feature that is
 * about a result sent through an app. The routes are the contract block at the top of lib/apps-wp11.ts.
 */

scenario("A message sent through an app does not reset the loop counter", { tag: ["@api"] }, async ({ server }) => {
  // Background
  const a = await appsWorld({ server });

  // Given conversation 41 is paused after 20 agent messages
  const picker = await postApp(a, validApp("picker-single-prototype-a2"), "Pick a runner");
  for (let i = 1; i < 20; i++) must(await agentPost(a.w.srv, i % 2 ? a.docs.lease : a.devtool.lease, a.conv, `Agent message ${i}`), `agent message ${i}`, 201); // two agents take turns: one alone would meet its burst limit first
  const paused = (await pageOf(a)).filter((m) => m.kind === "system");
  expect(paused.length).toBeGreaterThan(0);
  expect((await agentPost(a.w.srv, a.devtool.lease, a.conv, "Message 21")).status).toBe(429);

  // When the owner confirms an app result that posts a via_app message
  const sent = await ownerResult(a, picker, pickerResult(["vitest"]));
  expect(sent.status).toBe(201);

  // Then the next post from "devtool" answers 429
  const next = await agentPost(a.w.srv, a.devtool.lease, a.conv, "Message 22");
  expect(next.status).toBe(429);
  expect(next.json().error.code).toBe("conversation_paused");
});
