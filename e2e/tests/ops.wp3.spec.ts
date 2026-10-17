import { convoz, createConversation, ownerSays } from "../lib/chat.ts";
import { messageLog } from "../lib/chat-ui.ts";
import { expect, scenario } from "../lib/scenario.ts";
import { must, signIn } from "../lib/owner.ts";
import { countOf, dataFileBytes } from "../lib/machines.ts";
import { send } from "../lib/http.ts";
import { browserWorld, openChat, ownerDeletes, rowsOnList, showDetails, startSession, trashOf, world } from "../lib/wp3.ts";

// WP3's part of ops.feature: deleting a conversation is soft for 30 days, then a purge (I-49). The routes are listed at the top of
// tests/conversations.wp3.spec.ts. An agent is told 403 for a conversation it cannot see, whether or not it exists.

scenario("A deleted conversation goes to the trash and can come back", { tag: ["@browser"] }, async ({ server, page, context }) => {
  // Given conversation 41 with 12 messages
  const w = await browserWorld({ server, page, context });
  const conv = await createConversation(w.owner, { title: "Ship search filters", participants: ["devtool"] });
  for (let i = 1; i <= 12; i++) await ownerSays(w.owner, conv, `message ${i}`);
  await openChat(page, w.srv, conv, "Ship search filters");
  await expect(messageLog(page).getByRole("article")).toHaveCount(12);

  // When the owner deletes conversation 41
  const panel = await showDetails(page);
  await panel.getByRole("button", { name: "Delete conversation" }).click();
  await page.getByRole("dialog", { name: "Delete conversation" }).getByRole("button", { name: "Delete conversation" }).click();

  // Then it is gone from the rail and appears in Trash with "deleted forever in 30 days"
  await expect(page.getByRole("heading", { name: "Conversations", exact: true })).toBeVisible();
  await expect(rowsOnList(page)).toHaveCount(0);
  await page.goto(`${w.srv.origin}/account`);
  await page.getByRole("link", { name: "Trash" }).click();
  const trash = page.getByRole("list", { name: "Trash" });
  await expect(trash.getByRole("listitem")).toHaveCount(1);
  await expect(trash.getByRole("listitem")).toContainText("Ship search filters");
  await expect(trash.getByRole("listitem")).toContainText("deleted forever in 30 days");

  // And the owner restores it with all 12 messages
  await trash.getByRole("button", { name: "Restore Ship search filters" }).click();
  await expect(page.getByText(/Trash is empty/)).toBeVisible();
  await openChat(page, w.srv, conv, "Ship search filters");
  await expect(messageLog(page).getByRole("article")).toHaveCount(12);
  await page.goto(`${w.srv.origin}/chats`);
  await expect(rowsOnList(page)).toHaveCount(1);
});

scenario("An agent cannot see a conversation in the trash", { tag: ["@api"] }, async ({ server }) => {
  // Given "devtool" is in conversation 41 and the owner deleted it
  const w = await world(server);
  const conv = await createConversation(w.owner, { title: "Ship search filters", participants: ["devtool"] });
  await ownerSays(w.owner, conv, "Is the build green?");
  const dev = await startSession(w.box, "devtool", "devtool");
  expect((await convoz(w.box, dev.sid, ["read", String(conv)])).code).toBe(0);
  must(await ownerDeletes(w.owner, conv), "delete conversation 41");

  // When "devtool" runs "convoz read 41"
  const res = await convoz(w.box, dev.sid, ["read", String(conv)]);

  // Then the CLI exits 3
  expect(res.code).toBe(3);
  expect(res.stdout).not.toContain("Is the build green?");
  expect((await trashOf(w.owner)).map((c) => c.id)).toEqual([conv]);
});

scenario("The trash empties itself after 30 days", { tag: ["@cli"] }, async ({ server, dataDir, testApi }) => {
  // Given the owner deleted conversation 41 with the seeded body "ZQX-old-plan"
  const w = await world(server, { plaintext: true });
  const conv = await createConversation(w.owner, { title: "Ship search filters", participants: ["devtool"] });
  await ownerSays(w.owner, conv, "ZQX-old-plan");
  const dev = await startSession(w.box, "devtool", "devtool");
  expect(countOf(dataFileBytes(dataDir), "ZQX-old-plan"), "the scan must read plain text").toBeGreaterThan(0);
  must(await ownerDeletes(w.owner, conv), "delete conversation 41");
  expect((await trashOf(w.owner)).map((c) => c.id)).toEqual([conv]);

  // When the test clock moves 30 days and 1 hour and the nightly maintenance runs
  await testApi(w.srv).advanceClock((30 * 24 + 1) * 3_600_000);
  must(await send(w.srv.target, "POST", "/__test/maintenance", { json: {} }), "nightly maintenance");

  // Then Trash no longer lists conversation 41
  await signIn(w.owner.client, w.owner.soft); // thirty days on, the owner's device session has run out
  expect(await trashOf(w.owner)).toEqual([]);
  expect((await w.owner.client.get(`/api/conversations/${conv}`)).status).toBe(404);
  expect((await convoz(w.box, dev.sid, ["read", String(conv)])).code).toBe(3);

  // And a byte scan of the encryption-off test build's data file finds "ZQX-old-plan" 0 times
  expect(countOf(dataFileBytes(dataDir), "ZQX-old-plan")).toBe(0);
});
