import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ServerHandle, ServerOptions } from "../lib/fixtures.ts";
import { uiWorld } from "../lib/chat-ui.ts";
import { DEVICE_COOKIE, send } from "../lib/http.ts";
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

/** A dev tree like the Go tests use: a hashed asset, a file outside the folder, and symlinks out of and inside the build. */
function devTree(): { current: string; top: string } {
  const current = devDir();
  const top = path.dirname(current);
  const build = path.join(top, "releases", "r1");
  fs.writeFileSync(path.join(top, "secret.txt"), "SECRET-OUTSIDE\n");
  fs.writeFileSync(path.join(build, "assets", "main-Abc12345.js"), "console.log(1)");
  fs.symlinkSync(path.join(top, "secret.txt"), path.join(build, "escape.txt"));
  fs.symlinkSync(path.join("assets", "main-Abc12345.js"), path.join(build, "inside.js"));
  fs.symlinkSync("assets", path.join(build, "linked"));
  return { current, top };
}

/** The owner's cookie header, from the signed-in browser. */
async function ownerCookie(context: { cookies(): Promise<{ name: string; value: string }[]> }): Promise<string> {
  const c = (await context.cookies()).find((k) => k.name === DEVICE_COOKIE);
  if (!c) throw new Error("the owner's browser has no device cookie");
  return `${DEVICE_COOKIE}=${c.value}`;
}

scenario("The owner gets the dev build, uncached, under the console's policy", { tag: ["@api"] }, async ({ server, page, context }, info) => {
  info.setTimeout(90_000);
  // Given --dev-web-dir names a dev build
  const u = await uiWorld({ server: withDev(server, devTree().current), page, context }, { agents: ["devtool"] });
  const cookie = await ownerCookie(context);
  // When the owner's device session asks for /dev/, /dev/chats/12 and /dev/assets/<file>
  // Then each answers 200 with Cache-Control no-store (a hashed asset is kept a year) and the console's Content-Security-Policy
  for (const [p, cache] of [["/dev/", "no-store"], ["/dev/chats/12", "no-store"], ["/dev/assets/main-Abc12345.js", "public, max-age=31536000, immutable"]] as const) {
    const r = await send(u.w.srv.target, "GET", p, { cookie });
    expect(r.status, p).toBe(200);
    expect(r.headers["cache-control"], p).toBe(cache);
    expect(String(r.headers["content-security-policy"]), p).toContain("script-src 'self'");
  }
  // And a screen path answers the build's index.html, and a missing file under assets/ answers 404
  expect((await send(u.w.srv.target, "GET", "/dev/chats/12", { cookie })).text).toContain("Convoz dev");
  expect((await send(u.w.srv.target, "GET", "/dev/assets/gone.js", { cookie })).status).toBe(404);
  // And /dev answers a redirect to /dev/
  const bare = await send(u.w.srv.target, "GET", "/dev", { cookie });
  expect([bare.status, bare.headers["location"]]).toEqual([302, "/dev/"]);
});

scenario("With no folder, /dev is off", { tag: ["@api"] }, async ({ server, page, context }, info) => {
  info.setTimeout(90_000);
  // When --dev-web-dir names a missing folder, or a folder with no index.html (an empty --dev-web-dir is tested in Go)
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "convoz-devweb-empty-")), "none");
  const u = await uiWorld({ server: withDev(server, dir), page, context }, { agents: ["devtool"] });
  const cookie = await ownerCookie(context);
  // Then the owner gets 404 at /dev/ and at every path under it
  for (const p of ["/dev/", "/dev/chats"]) expect((await send(u.w.srv.target, "GET", p, { cookie })).status, `missing folder ${p}`).toBe(404);
  fs.mkdirSync(dir);
  for (const p of ["/dev/", "/dev/chats"]) expect((await send(u.w.srv.target, "GET", p, { cookie })).status, `folder with no index.html ${p}`).toBe(404);
});

scenario("Traversal and symlinks are refused", { tag: ["@api"] }, async ({ server, page, context }, info) => {
  info.setTimeout(90_000);
  // Given --dev-web-dir names a dev build that holds a symlink out of the folder and symlinks inside it
  const u = await uiWorld({ server: withDev(server, devTree().current), page, context }, { agents: ["devtool"] });
  const cookie = await ownerCookie(context);
  // When the owner asks for /dev/../secret.txt, /dev/%2e%2e/secret.txt, /dev/..%2f..%2fsecret.txt and each symlink
  // Then no answer carries the file outside the folder
  for (const p of ["/dev/../secret.txt", "/dev/%2e%2e/secret.txt", "/dev/%2e%2e%2fsecret.txt", "/dev/..%2f..%2fsecret.txt", "/dev/escape.txt"]) {
    expect((await send(u.w.srv.target, "GET", p, { cookie })).text, p).not.toContain("SECRET-OUTSIDE");
  }
  // And every symlink in the build answers 404
  for (const p of ["/dev/escape.txt", "/dev/inside.js", "/dev/linked/main-Abc12345.js"]) expect((await send(u.w.srv.target, "GET", p, { cookie })).status, p).toBe(404);
});

scenario("A new build shows at the next request, with no restart", { tag: ["@api"] }, async ({ server, page, context }, info) => {
  info.setTimeout(90_000);
  // Given the owner has loaded /dev/
  const { current, top } = devTree();
  const u = await uiWorld({ server: withDev(server, current), page, context }, { agents: ["devtool"] });
  const cookie = await ownerCookie(context);
  expect((await send(u.w.srv.target, "GET", "/dev/", { cookie })).text).toContain("Convoz dev");
  // When a new current symlink to a new release folder is renamed over the old one
  const next = path.join(top, "releases", "r2");
  fs.mkdirSync(next, { recursive: true });
  fs.writeFileSync(path.join(next, "index.html"), "<title>NEXT BUILD</title>");
  fs.symlinkSync(path.join("releases", "r2"), `${current}.new`);
  fs.renameSync(`${current}.new`, current);
  // Then the next request answers the new build
  expect((await send(u.w.srv.target, "GET", "/dev/", { cookie })).text).toContain("NEXT BUILD");
});

scenario("The dev build is made in CI, gated, and handed over by checksum", { tag: ["@api"] }, async () => {
  // When a commit is force-pushed to the dev-web branch, the workflow reads like the contract (a text check: the job itself runs on GitHub)
  const flow = fs.readFileSync(path.resolve(import.meta.dirname, "../../.github/workflows/dev-web.yml"), "utf8");
  // Then it fails unless the base branch's scripts/fast_lane.py says ELIGIBLE
  expect(flow).toContain("fast_lane.py");
  expect(flow).toContain("grep -qx 'ELIGIBLE'");
  // And its one job, dev-web, fails unless the build is regular files and folders ... at most 5000 files
  expect(flow).toMatch(/^ {2}dev-web:/m);
  expect(flow).toContain("test \"$files\" -le 5000");
  // And it uploads the artifact dev-web-<sha> and prints its sha256 once as a notice titled sha256
  expect(flow).toContain("dev-web-${{ github.sha }}");
  expect(flow).toContain("::notice title=sha256::$sum");
});

scenario("A new dev build shows at the next load, with no restart", { tag: ["@browser"] }, async ({ server, page, context }, info) => {
  info.setTimeout(90_000);
  // Given the owner has the dev copy open
  const { current, top } = devTree();
  const u = await uiWorld({ server: withDev(server, current), page, context }, { agents: ["devtool"] });
  await page.goto(`${u.w.srv.origin}/dev/`);
  expect(await page.title()).toBe("Convoz dev");
  // When a new dev build is put in place and the owner loads the page again
  const next = path.join(top, "releases", "r2");
  fs.mkdirSync(next, { recursive: true });
  fs.writeFileSync(path.join(next, "index.html"), "<title>NEXT BUILD</title>");
  fs.symlinkSync(path.join("releases", "r2"), `${current}.new`);
  fs.renameSync(`${current}.new`, current);
  await page.reload();
  // Then the new build shows, and the server did not restart (the same server answered)
  expect(await page.title()).toBe("NEXT BUILD");
});

scenario("Nobody else can tell the dev copy exists", { tag: ["@browser"] }, async ({ server, page, context }, info) => {
  info.setTimeout(90_000);
  // Given an agent and a visitor who is not signed in
  const u = await uiWorld({ server: withDev(server, devDir()), page, context }, { agents: ["devtool"] });
  const unknown = await send(u.w.srv.target, "GET", "/no-such-page-at-all/", { cookie: null });
  // When either asks for the dev copy, then they see the same not-found page as for a page that does not exist
  const visitor = await send(u.w.srv.target, "GET", "/dev/", { cookie: null });
  const agent = await send(u.w.srv.target, "GET", "/dev/", { cookie: null, ...bearer(u.sessions.devtool!.lease) });
  expect([visitor.status, visitor.text]).toEqual([404, unknown.text]);
  expect(agent.status).toBe(404);
  expect(agent.text).not.toContain("DEV");
});
