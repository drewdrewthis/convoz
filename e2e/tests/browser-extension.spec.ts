import { EXTENSION_ORIGIN, grantHostAccess, launchWithExtension, openPanel, setServer, signInOwner } from "../lib/extension.ts";
import type { ServerOptions } from "../lib/fixtures.ts";
import { bootstrapOwner, must } from "../lib/owner.ts";
import { expect, scenario } from "../lib/scenario.ts";

/*
 * browser-extension.feature (issue 44, version 2 of conv 310). The unpacked extension in Chromium against `convoz serve`;
 * lib/extension.ts says which steps of the owner's hand the test takes through Chrome's own pages (host access, the toolbar click).
 *   serve --extension-origin chrome-extension://<id> (CONVOZ_EXTENSION_ORIGIN).
 *   The panel: GET /api/me with the browser's session cookie; signed in, it shows the web app in an iframe (page-share.spec.ts);
 *   signed out (401), "Sign in to Convoz" and no iframe.
 * Desktop Chromium only: playwright.config.ts keeps this file out of the "mobile" project.
 */

const withExtension = (o: ServerOptions = {}): ServerOptions => ({ host: "localhost", adminSocket: true, extraArgs: ["--extension-origin", EXTENSION_ORIGIN], ...o });

scenario("The panel of a signed-out browser offers sign in", { tag: ["@browser"] }, async ({ server }, info) => {
  // Given a Convoz server that allows the extension and a browser with no Convoz sign-in
  const srv = await server(withExtension());
  await bootstrapOwner(srv);
  const context = await launchWithExtension();
  try {
    await grantHostAccess(context, srv.origin);

    // When the owner sets the server address in the panel
    const panel = await openPanel(context);
    await setServer(panel, srv.origin);

    // Then the panel shows "Sign in to Convoz" and no chat
    const signIn = panel.getByRole("button", { name: "Sign in to Convoz" });
    await expect(signIn).toBeVisible();
    await expect(panel.locator("iframe")).toHaveCount(0);
    await info.attach("signed-out panel", { body: await panel.screenshot(), contentType: "image/png" });

    // And "Sign in to Convoz" opens the sign-in page of that server in a new tab
    const opened = context.waitForEvent("page");
    await signIn.click();
    const tab = await opened;
    await tab.waitForURL(`${srv.origin}/signin`);
    await expect(tab.getByRole("heading", { name: "Sign in" })).toBeVisible();
  } finally {
    await context.close();
  }
});

scenario("Refused access to the server shows no chat", { tag: ["@browser"] }, async ({ server }, info) => {
  const srv = await server(withExtension());
  const owner = await bootstrapOwner(srv);
  const context = await launchWithExtension();
  try {
    await signInOwner(context, srv, owner);

    // Given the panel has no server address yet
    const panel = await openPanel(context);
    await expect(panel.getByLabel("Convoz server")).toHaveValue("");

    // When the owner types the server address and refuses Chrome's access prompt
    // (Chrome's prompt is browser UI a test cannot click: the refusal is what chrome.permissions.request resolves to)
    await panel.evaluate(() => {
      (globalThis as unknown as { chrome: { permissions: { request(): Promise<boolean> } } }).chrome.permissions.request = async () => false;
    });
    await setServer(panel, srv.origin);

    // Then the panel says Convoz needs access to that server and shows no chat
    await expect(panel.getByRole("status")).toHaveText(`Convoz needs access to ${srv.origin}.`);
    await expect(panel.locator("iframe")).toHaveCount(0);
    expect(must(await owner.client.get("/api/conversations"), "list conversations").json().conversations).toEqual([]);
    await info.attach("refused access", { body: await panel.screenshot(), contentType: "image/png" });
  } finally {
    await context.close();
  }
});
