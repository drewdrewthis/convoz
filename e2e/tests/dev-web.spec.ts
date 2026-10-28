import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ServerHandle, ServerOptions } from "../lib/fixtures.ts";
import { uiWorld } from "../lib/chat-ui.ts";
import { send } from "../lib/http.ts";
import { bearer } from "../lib/machines.ts";
import { installed } from "../lib/wp17.ts";
import { expect, scenario } from "../lib/scenario.ts";

/*
 * THE OWNER'S DEV COPY (/dev/, `convoz serve --dev-web-dir`). Read with specs/contracts/dev-web.feature. The route itself is tested in
 * Go (apps/convoz/internal/server/httpapi/dev_web_test.go); these scenarios prove it in a real browser that already runs the real app's
 * service worker, and through the real listener.
 */

/** devDir lays out a dev folder as prod has it (current -> releases/<id>) with a page that shows the DEV badge, and returns current. */
function devDir(): string {
  const top = fs.mkdtempSync(path.join(os.tmpdir(), "convoz-devweb-"));
  const build = path.join(top, "releases", "r1");
  fs.mkdirSync(path.join(build, "assets"), { recursive: true });
  fs.writeFileSync(
    path.join(build, "index.html"),
    '<!doctype html>\n<html lang="en">\n<head><title>Convoz dev</title><link rel="stylesheet" href="/dev/assets/dev.css"></head>\n<body><div class="dev-badge" role="status">DEV</div></body>\n</html>\n',
  );
  fs.writeFileSync(path.join(build, "assets", "dev.css"), ".dev-badge { color: rgb(217, 45, 32); }\n");
  fs.symlinkSync(path.join("releases", "r1"), path.join(top, "current"));
  return path.join(top, "current");
}

/** withDev is the server fixture with --dev-web-dir set (through its environment default). */
function withDev(server: (o?: ServerOptions) => Promise<ServerHandle>, dir: string): (o?: ServerOptions) => Promise<ServerHandle> {
  return (o: ServerOptions = {}) => server({ ...o, env: { ...(o.env ?? {}), CONVOZ_DEV_WEB_DIR: dir } });
}

scenario("The real app's service worker never answers a request under /dev", { tag: ["@browser"] }, async ({ server, page, context }, info) => {
  info.setTimeout(90_000);
  const u = await uiWorld({ server: withDev(server, devDir()), page, context }, { agents: ["devtool"] });
  // Given the owner opened the real app and its service worker controls the page
  await page.goto(`${u.w.srv.origin}/`);
  await installed(page);
  expect(await page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);

  // When the owner opens /dev/ in the same browser
  const viaWorker: string[] = [];
  page.on("response", (r) => {
    if (new URL(r.url()).pathname.startsWith("/dev") && r.fromServiceWorker()) viaWorker.push(r.url());
  });
  const answer = await page.goto(`${u.w.srv.origin}/dev/`);

  // Then the dev page renders from the network, with its DEV badge, never the cached shell of the real app
  expect(answer?.status()).toBe(200);
  expect(answer?.fromServiceWorker(), "the /dev/ page came from the service worker").toBe(false);
  await expect(page.getByRole("status").filter({ hasText: "DEV" })).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: "DEV" })).toHaveCSS("color", "rgb(217, 45, 32)");
  expect(await page.title()).toBe("Convoz dev");
  expect(viaWorker, "requests under /dev answered by the service worker").toEqual([]);
});

scenario("Everyone but the owner gets 404 at /dev, as for an unknown path", { tag: ["@api"] }, async ({ server, page, context }, info) => {
  info.setTimeout(90_000);
  const u = await uiWorld({ server: withDev(server, devDir()), page, context }, { agents: ["devtool"] });
  const srv = u.w.srv;
  // The owner's own browser gets the page, uncached
  const own = await context.request.get(`${srv.origin}/dev/`);
  expect(own.status()).toBe(200);
  expect(own.headers()["cache-control"]).toBe("no-store");
  const unknown = await send(srv.target, "GET", "/no-such-page-at-all/", { cookie: null });
  for (const p of ["/dev", "/dev/", "/dev/chats", "/dev/assets/dev.css"]) {
    // A caller with no cookie
    const anon = await send(srv.target, "GET", p, { cookie: null });
    expect(anon.status, `signed out ${p}`).toBe(404);
    expect(anon.text, `signed out ${p}`).toBe(unknown.text);
    // An agent's lease
    const agent = await send(srv.target, "GET", p, { cookie: null, ...bearer(u.sessions.devtool!.lease) });
    expect(agent.status, `agent ${p}`).toBe(404);
    expect(agent.text, `agent ${p}`).not.toContain("DEV");
  }
});
