import type { Page } from "@playwright/test";
import { createConversation, ownerSays } from "../lib/chat.ts";
import { signInBrowser } from "../lib/machines.ts";
import { bootstrapOwner } from "../lib/owner.ts";
import { expect, scenario } from "../lib/scenario.ts";
import { createAgents } from "../lib/machines.ts";

// Bindings of onboarding.feature that no earlier work package bound. "A recovery code lets the owner add a new passkey only" stays open:
// its push "Recovery code used" is the notifications work package. The two PWA scenarios (Add to Home Screen, update waits for a tap)
// belong to the offline work package.

/** How many rows each store of the app's IndexedDB cache ("convoz") holds, by store name. */
const cacheRows = (page: Page): Promise<Record<string, number>> =>
  page.evaluate(
    () =>
      new Promise<Record<string, number>>((resolve) => {
        const open = indexedDB.open("convoz");
        open.onerror = () => resolve({});
        open.onsuccess = () => {
          const db = open.result;
          const names = [...db.objectStoreNames];
          const out: Record<string, number> = {};
          if (names.length === 0) {
            db.close();
            resolve(out);
            return;
          }
          const tx = db.transaction(names);
          let left = names.length;
          for (const name of names) {
            const count = tx.objectStore(name).count();
            count.onsuccess = () => {
              out[name] = count.result;
              if (--left === 0) {
                db.close();
                resolve(out);
              }
            };
          }
        };
      }),
  );

scenario("Logout clears the device", { tag: ["@browser"] }, async ({ server, page, context }) => {
  // Given the installed app cached conversations
  const srv = await server({ host: "localhost", adminSocket: true });
  const owner = await bootstrapOwner(srv);
  await createAgents(owner, "devtool");
  const conv = await createConversation(owner, { title: "Ship search filters", participants: ["devtool"] });
  await ownerSays(owner, conv, "Remember this one");
  await signInBrowser(srv, owner, page, context);
  await page.goto(`${srv.origin}/chats/${conv}`);
  await expect(page.getByText("Remember this one")).toBeVisible();
  await expect.poll(async () => (await cacheRows(page)).conversations ?? 0).toBeGreaterThan(0);
  await expect.poll(async () => (await cacheRows(page)).messages ?? 0).toBeGreaterThan(0);

  // When the owner logs out
  await page.goto(`${srv.origin}/chats`);
  await page.getByRole("button", { name: "Account menu" }).click();
  await page.getByRole("menuitem", { name: "Sign out" }).click();

  // Then the app shows sign in
  await expect(page.getByRole("heading", { name: "Sign in", level: 1 })).toBeVisible();

  // And no cached conversation is left on the device
  const rows = await cacheRows(page);
  expect(Object.values(rows).reduce((a, b) => a + b, 0), JSON.stringify(rows)).toBe(0);
  expect(await page.evaluate(() => caches.keys())).toEqual([]);
});
