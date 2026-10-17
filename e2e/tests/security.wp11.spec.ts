import { convoz } from "../lib/chat.ts";
import { appCard, appFrame, appsWorld, frameHtml, openApp, openConversation, pageOf, postFrame, resultSheet, viaAppRows } from "../lib/apps-wp11.ts";
import { expect, scenario } from "../lib/scenario.ts";

/*
 * SECURITY, the app part (WP11): the bindings of the two scenarios of specs/features/security.feature about Tier-2 apps. The page contract is
 * the one at the top of lib/apps-wp11.ts.
 */

scenario("An app cannot send without the owner's tap", { tag: ["@browser"] }, async ({ server, page, context, dataDir }) => {
  // Background
  const a = await appsWorld({ server, page, context, browser: true });

  // Given a Tier-2 app message from "devtool" whose script posts a result on load
  await postFrame(
    a,
    frameHtml(`<p id="s">starting</p>`, `convoz.onInit(function () { document.getElementById("s").textContent = "posted"; convoz.result({ summary: "Roll back box-3", value: { action: "rollback" } }); });`),
    { title: "Eager" },
  );

  // When the owner opens the conversation and taps nothing
  await openConversation(page, a.w.srv, a.conv);
  await openApp(page, "Eager", "posted"); // the app has to be opened to run at all; that is the only tap

  // Then no message is sent
  await expect(resultSheet(page)).toBeVisible();
  await page.waitForTimeout(800);
  expect(viaAppRows(dataDir)).toEqual([]);
  expect((await pageOf(a)).filter((m) => m.author.handle === "drew")).toEqual([]);

  // And a confirm sheet drawn by the host shows the proposed result
  await expect(resultSheet(page)).toContainText("Roll back box-3");
  await expect(resultSheet(page).getByRole("button", { name: "Send" })).toBeVisible();
});

scenario("A message sent through an app is attributed", { tag: ["@browser", "@cli"] }, async ({ server, page, context }) => {
  // Background
  const a = await appsWorld({ server, page, context, browser: true });

  // Given a Tier-2 app message from "devtool"
  await postFrame(
    a,
    frameHtml(
      `<p id="s">starting</p><button id="b">Roll back</button>`,
      `convoz.onInit(function () { document.getElementById("s").textContent = "ready"; document.getElementById("b").onclick = function () { convoz.result({ summary: "Roll back box-3", value: { action: "rollback" } }); }; });`,
    ),
    { title: "Rollback" },
  );
  await openConversation(page, a.w.srv, a.conv);
  await openApp(page, "Rollback", "ready");

  // When the owner confirms its result on the host sheet
  await appFrame(page, "Rollback").getByRole("button", { name: "Roll back" }).click();
  await resultSheet(page).getByRole("button", { name: "Send" }).click();

  // Then the conversation shows the message with "via app by @devtool"
  await expect(page.getByText("via app by @devtool")).toBeVisible();
  await expect(appCard(page, "Rollback")).toBeVisible();

  // And "convoz read 41" shows the same attribution
  const read = await convoz(a.w.box, a.devtool.sid, ["read", String(a.conv)]);
  expect(read.code).toBe(0);
  expect(read.stdout).toContain("via app by @devtool");
});
