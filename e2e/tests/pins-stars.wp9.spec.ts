import { message } from "../lib/chat-ui.ts";
import { convoz, ownerSays } from "../lib/chat.ts";
import { send } from "../lib/http.ts";
import { agentSays, apiRailWorld, openRail, railGroup, railRow, railWorld, setPrefs, signInWith, TITLES } from "../lib/rail-wp9.ts";
import { expect, scenario } from "../lib/scenario.ts";
import { asAgent, showDetails, unreadFor } from "../lib/wp3.ts";

/*
 * pins-stars.feature (and its contract in specs/contracts/pins-stars.feature): stars, pins and mute of the owner. The page contract is
 * the comment block of lib/rail-wp9.ts, plus: the message menu ("Message actions") has Pin / Unpin; a pinned message carries an image
 * named "Pinned"; the details list "Pinned in this conversation"; the details button Mute / Unmute and the title bar's "Muted".
 */

const [T41, T52, T60] = TITLES;
const RUNBOOK = "Runbook: https://docs.acme.dev/runbooks/deploy-alerts";

const toastSays = (page: import("@playwright/test").Page, text: string) => page.getByRole("status").filter({ hasText: new RegExp(`^${text}$`) });

scenario("Starring a conversation puts it at the top of Starred", { tag: ["@browser"] }, async ({ server, page, context }) => {
  const u = await railWorld({ server, page, context });

  // Given conversation 52 is starred
  await setPrefs(u.w.owner, u.c[52], { starred: true });
  await openRail(page, u.w.srv);
  await expect(railGroup(page, "Starred").locator(".rtitle")).toHaveText([T52]);

  // When the owner stars conversation 60
  await railRow(page, T60).hover(); // the star shows on hover, in the place of the count
  await page.getByRole("button", { name: `Star conversation ${T60}` }).click();

  // Then the Starred group lists 60 above 52
  await expect(railGroup(page, "Starred").locator(".rtitle")).toHaveText([T60, T52]);

  // And a toast says "Starred"
  await expect(toastSays(page, "Starred")).toBeVisible();
});

scenario("Unstarring puts a conversation at the top of Conversations", { tag: ["@browser"] }, async ({ server, page, context }) => {
  const u = await railWorld({ server, page, context });

  // Given conversation 60 is starred
  await setPrefs(u.w.owner, u.c[60], { starred: true });
  await openRail(page, u.w.srv);
  await expect(railGroup(page, "Starred").locator(".rtitle")).toHaveText([T60]);

  // When the owner unstars it
  await railRow(page, T60).hover();
  await page.getByRole("button", { name: `Unstar conversation ${T60}` }).click();

  // Then conversation 60 is first in the Conversations group
  await expect(railGroup(page, "Conversations").locator(".rtitle")).toHaveText([T60, T52, T41]);
  await expect(toastSays(page, "Unstarred")).toBeVisible();
});

scenario("The star state survives a reload and shows on other devices", { tag: ["@browser"] }, async ({ server, page, context, browser }) => {
  const u = await railWorld({ server, page, context });
  await openRail(page, u.w.srv);

  // A second browser of the owner has the rail open
  const other = await browser.newContext();
  try {
    const page2 = await other.newPage();
    await signInWith(u.w.srv, u.second, page2, other);
    await openRail(page2, u.w.srv);
    await expect(railGroup(page2, "Conversations").locator(".rtitle")).toHaveText([T60, T52, T41]);

    // When the owner stars conversation 41
    await railRow(page, T41).hover();
    await page.getByRole("button", { name: `Star conversation ${T41}` }).click();

    // Then a second browser of the owner shows 41 in Starred with no reload
    await expect(railGroup(page2, "Starred").locator(".rtitle")).toHaveText([T41], { timeout: 3_000 });
    await expect(railGroup(page2, "Conversations").locator(".rtitle")).toHaveText([T60, T52]);

    // and the first browser keeps it after a reload
    await page.reload();
    await expect(railGroup(page, "Starred").locator(".rtitle")).toHaveText([T41]);
  } finally {
    await other.close();
  }
});

scenario("Pinning a message adds it to the pinned list", { tag: ["@browser"] }, async ({ server, page, context }) => {
  const u = await railWorld({ server, page, context });

  // Given "devtool" posted "Runbook: https://docs.acme.dev/runbooks/deploy-alerts" in conversation 52
  await agentSays(u.w, "devtool", u.c[52], RUNBOOK);
  await page.goto(`${u.w.srv.origin}/chats/${u.c[52]}`);
  const row = message(page, "Runbook:");
  await expect(row).toBeVisible();

  // When the owner pins that message
  await row.hover();
  await row.getByRole("button", { name: "Message actions" }).click();
  await page.getByRole("menuitem", { name: "Pin", exact: true }).click();

  // Then the message shows a pin mark
  await expect(row.getByRole("img", { name: "Pinned" })).toBeVisible();

  // And "Pinned in this conversation" lists it
  const panel = await showDetails(page);
  await expect(panel.getByRole("heading", { name: "Pinned in this conversation" })).toBeVisible();
  await expect(panel.getByRole("list", { name: "Pinned messages" }).getByText(RUNBOOK)).toBeVisible();
});

scenario("Unpinning removes it from the list", { tag: ["@browser"] }, async ({ server, page, context }) => {
  const u = await railWorld({ server, page, context });

  // Given a pinned message in conversation 52
  const id = await ownerSays(u.w.owner, u.c[52], RUNBOOK);
  expect((await u.w.owner.client.request("PUT", `/api/messages/${id}/pin`, { csrf: true, json: {} })).status).toBe(200);
  await page.goto(`${u.w.srv.origin}/chats/${u.c[52]}`);
  const row = message(page, "Runbook:");
  await expect(row.getByRole("img", { name: "Pinned" })).toBeVisible();

  // When the owner unpins it
  await row.hover();
  await row.getByRole("button", { name: "Message actions" }).click();
  await page.getByRole("menuitem", { name: "Unpin", exact: true }).click();
  await expect(row.getByRole("img", { name: "Pinned" })).toHaveCount(0);

  // Then "Pinned in this conversation" no longer lists it
  const panel = await showDetails(page);
  await expect(panel.getByRole("heading", { name: "Pinned in this conversation" })).toBeVisible();
  await expect(panel.getByRole("list", { name: "Pinned messages" })).toHaveCount(0);
  await expect(panel.getByText(RUNBOOK)).toHaveCount(0);
});

scenario("A muted conversation shows Muted and sends no push", { tag: ["@browser"] }, async ({ server, page, context }) => {
  const u = await railWorld({ server, page, context });
  await page.goto(`${u.w.srv.origin}/chats/${u.c[60]}`);
  await page.getByRole("heading", { name: T60, level: 1 }).waitFor();

  // When the owner mutes conversation 60
  const panel = await showDetails(page);
  await panel.getByRole("button", { name: "Mute", exact: true }).click();
  await expect(panel.getByRole("button", { name: "Unmute", exact: true })).toBeVisible();
  await panel.getByRole("button", { name: "Close details" }).click();

  // Then the conversation title bar shows "Muted"
  await expect(page.getByRole("banner").getByText("Muted", { exact: true })).toBeVisible();

  // And a new message in conversation 60 creates a notification record with the reason "muted" and no push
  // (the pipeline is WP14 and a plain message is not a trigger, so the new message is one that mentions the owner)
  await agentSays(u.w, "devtool", u.c[60], "@drew please look at the deploy");
  await expect
    .poll(async () => (await send(u.w.srv.target, "GET", "/__test/notifications")).json().notifications.filter((n: { conversation_id: number }) => n.conversation_id === u.c[60]), { timeout: 5_000 })
    .toEqual([expect.objectContaining({ reason: "mention", decision: "suppressed", suppressed_reason: "muted" })]);
});

scenario("An agent's read state is its own", { tag: ["@api"] }, async ({ server }) => {
  // Given "devtool" and "docs" are in conversation 41 and "docs" read it all
  const u = await apiRailWorld(server);
  await ownerSays(u.w.owner, u.c[41], "Please look at the filters");
  const read = await convoz(u.w.box, u.w.sessions.docs.sid, ["read", "--json", String(u.c[41])]);
  expect(read.code, read.stderr).toBe(0);
  expect(await unreadFor(u.w.srv, u.w.sessions.docs.lease, u.c[41])).toBe(0);

  // When "devtool" asks for its conversations
  const unread = await unreadFor(u.w.srv, u.w.sessions.devtool.lease, u.c[41]);

  // Then conversation 41 shows unread for "devtool"
  expect(unread).toBeGreaterThan(0);
});

scenario("An agent cannot pin or star", { tag: ["@api"] }, async ({ server }) => {
  const u = await apiRailWorld(server);
  const id = await ownerSays(u.w.owner, u.c[41], "Pin this");

  // When "devtool" pins a message in conversation 41
  const pin = await asAgent(u.w.srv, u.w.sessions.devtool.lease, "PUT", `/api/messages/${id}/pin`, {});

  // Then the server answers 403
  expect(pin.status, pin.text).toBe(403);

  // And starring conversation 41 as "devtool" also answers 403
  const star = await asAgent(u.w.srv, u.w.sessions.devtool.lease, "PATCH", `/api/conversations/${u.c[41]}/prefs`, { starred: true });
  expect(star.status, star.text).toBe(403);
});
