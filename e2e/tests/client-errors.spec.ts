import type { Page } from "@playwright/test";
import { uiWorld } from "../lib/chat-ui.ts";
import { agentServer, viaAgent } from "../lib/agent-port.ts";
import { createConversation, startSession } from "../lib/chat.ts";
import { installedMachine } from "../lib/cli.ts";
import type { ServerHandle } from "../lib/fixtures.ts";
import { send } from "../lib/http.ts";
import { allow, bearer, createAgents, loginMachine } from "../lib/machines.ts";
import { bootstrapOwner } from "../lib/owner.ts";
import { expect, scenario } from "../lib/scenario.ts";

/*
 * Errors in the web app go to the server's own log. Read with specs/features/client-errors.feature and
 * specs/contracts/client-errors.feature.
 * Owner decision (ask 231, answered at msg 232): "Errors to server log". The option text was: "The app posts uncaught errors
 * (message, stack, page, build) to the server, which writes them to its own log. No third party, small, and I can read it with journalctl."
 */

const TITLE = "Ship search filters";

/** The `client_error` lines of the server log so far. */
const lines = (srv: ServerHandle): string[] => srv.log().split("\n").filter((l) => l.includes("client_error "));

/** Wait for a `client_error` line that holds `text`. */
async function lineWith(srv: ServerHandle, text: string): Promise<string> {
  await expect.poll(() => lines(srv).find((l) => l.includes(text)), { timeout: 15_000, message: `a client_error line with ${text}` }).toBeTruthy();
  return lines(srv).find((l) => l.includes(text))!;
}

/** Throw outside any handler, as a script error that nothing catches. */
const uncaught = (page: Page, message: string) => page.evaluate((m) => void setTimeout(() => { throw new Error(m); }, 0), message);

scenario("An uncaught error in the web app reaches the server log", { tag: ["@browser"] }, async ({ server, page, context }) => {
  // Background: a fresh Convoz server with owner "drew" signed in in a browser
  const u = await uiWorld({ server, page, context });
  await createConversation(u.w.owner, { participants: ["devtool"], title: TITLE });

  // Given the owner has the chat list open
  await page.goto(`${u.w.srv.origin}/chats`);
  await expect(page.getByRole("link", { name: new RegExp(TITLE) }).first()).toBeVisible();

  // When a script error that nothing catches happens in the open page
  await uncaught(page, "TESTONLY uncaught boom");

  // Then the server log has one "client_error" line with the error's message, a stack, the page "/chats", the build and the browser
  const line = await lineWith(u.w.srv, "TESTONLY uncaught boom");
  expect(line).toMatch(/ build="[^"]+"/);
  expect(line).toContain(' page="/chats"');
  expect(line).toMatch(/ ua="Mozilla\/[^"]*"/);
  expect(line).toMatch(/ stack="[^"]*boom/);
  expect(lines(u.w.srv).filter((l) => l.includes("TESTONLY uncaught boom"))).toHaveLength(1);

  // And the line does not hold the part of the address after the question mark
  await page.goto(`${u.w.srv.origin}/chats?ticket=TESTONLY-secret`);
  await uncaught(page, "TESTONLY second boom");
  expect(await lineWith(u.w.srv, "TESTONLY second boom")).not.toContain("TESTONLY-secret");
});

scenario("A crash shows a reload message instead of a blank page", { tag: ["@browser"] }, async ({ server, page, context }) => {
  // Background: a fresh Convoz server with owner "drew" signed in in a browser
  const u = await uiWorld({ server, page, context });
  await createConversation(u.w.owner, { participants: ["devtool"], title: TITLE });

  // Given the owner has the chat list open
  await page.goto(`${u.w.srv.origin}/chats`);
  await expect(page.getByRole("link", { name: new RegExp(TITLE) }).first()).toBeVisible();
  await expect(page.getByText("Something went wrong.")).toHaveCount(0);

  // When the page crashes while it draws (the list is answered with rows the page cannot draw)
  await page.route("**/api/conversations", (route) => route.fulfill({ json: [{ id: 1, participants: null, last: null }] }));
  await page.reload();

  // Then the page says "Something went wrong." with a "Reload" button
  await expect(page.getByText("Something went wrong.")).toBeVisible();
  const reload = page.getByRole("button", { name: "Reload" });
  await expect(reload).toBeVisible();

  // And the server log has a "client_error" line for the crash
  await lineWith(u.w.srv, ' page="/chats"');

  // And the owner presses "Reload" and the chat list is back
  await page.unroute("**/api/conversations");
  await reload.click();
  await expect(page.getByRole("link", { name: new RegExp(TITLE) }).first()).toBeVisible();
});

scenario("Client error reports are capped and need the owner", { tag: ["@api"] }, async ({ server }) => {
  // Background: a fresh Convoz server with owner "drew" signed in (and an agents-only port, for the last step)
  const srv = await server(agentServer());
  const owner = await bootstrapOwner(srv);
  await createAgents(owner, "devtool");
  const box = await installedMachine(srv.origin, "box-2", (await loginMachine(srv, owner, "box-2", allow("devtool"))).key);
  const lease = (await startSession(box, "devtool", "client-errors")).lease;
  const report = (o: object) => owner.client.post("/api/client-errors", { message: "m", stack: "s", page: "/", build: "b", ua: "u", at: 1, ...o });

  // When the owner sends POST /api/client-errors with a 900-character message and a 9000-character stack
  const first = await report({ message: `${"M".repeat(450)}\nclient_error forged=1\n${"M".repeat(450)}`, stack: "S".repeat(9000) });

  // Then the server answers 204 and the log line holds at most 500 characters of the message and 4096 of the stack
  expect(first.status).toBe(204);
  const line = await lineWith(srv, "MMMM");
  expect(line.match(/M/g)!.length).toBeLessThanOrEqual(500);
  expect(line.match(/S/g)!.length).toBeLessThanOrEqual(4096);
  expect(line.match(/S/g)!.length).toBeGreaterThan(4000);

  // And the line is one line: a newline in the message is written as \n
  expect(line).toContain("\\nclient_error forged=1\\n");
  expect(lines(srv).filter((l) => l.includes("forged=1"))).toHaveLength(1);
  const logged = lines(srv).length;

  // When the owner sends a report over 16 KB
  const before = logged;
  const big = await report({ message: "X".repeat(17 * 1024) });

  // Then the server answers 400 and writes no line
  expect(big.status).toBe(400);
  expect(lines(srv)).toHaveLength(before);

  // When the owner sends 60 reports in an hour and then one more (the two above count)
  for (let i = 0; i < 58; i++) expect((await report({ message: `r${i}` })).status).toBe(204);
  const over = await report({ message: "one more" });

  // Then the one more is answered 429 with Retry-After
  expect(over.status).toBe(429);
  expect(Number(over.headers["retry-after"])).toBeGreaterThan(0);
  expect(srv.log()).not.toContain("one more");

  // When an anonymous caller or an agent with a session lease sends a report
  const anon = await send(srv.target, "POST", "/api/client-errors", { csrf: true, json: { message: "TESTONLY-anon", stack: "", page: "/", build: "b", ua: "u", at: 1 } });
  const agent = await send(srv.target, "POST", "/api/client-errors", { csrf: true, json: { message: "TESTONLY-agent", stack: "", page: "/", build: "b", ua: "u", at: 1 }, ...bearer(lease) });

  // Then the server answers 401 and writes no line
  expect([anon.status, agent.status]).toEqual([401, 401]);
  expect(srv.log()).not.toMatch(/TESTONLY-(anon|agent)/);

  // And the agents-only port answers 404 for the route
  const viaPort = await viaAgent(srv, "POST", "/api/client-errors", { csrf: false, json: { message: "TESTONLY-port" }, bearer: lease, headers: { "X-Convoz": "1" } });
  expect(viaPort.status).toBe(404);
  expect(srv.log()).not.toContain("TESTONLY-port");
});

scenario("A report holds no query string and no token", { tag: ["@browser"] }, async ({ server, page, context }) => {
  // Background: a fresh Convoz server with owner "drew" signed in
  const u = await uiWorld({ server, page, context });
  await createConversation(u.w.owner, { participants: ["devtool"], title: TITLE });

  // Given the owner has the chat list open at an address with a query "?ticket=TESTONLY-secret"
  await page.goto(`${u.w.srv.origin}/chats?ticket=TESTONLY-secret`);
  await expect(page.getByRole("link", { name: new RegExp(TITLE) }).first()).toBeVisible();

  // When a script error that carries a 40-character token in its message happens in the open page
  const token = "TESTONLYtoken0123456789abcdefghijklmnopq";
  expect(token).toHaveLength(40);
  await uncaught(page, `bad call https://example.test/x?ticket=TESTONLY-secret with key ${token}`);

  // Then the "client_error" line has the page "/chats", no "TESTONLY-secret" and no 40-character token
  const line = await lineWith(u.w.srv, "bad call");
  expect(line).toContain(' page="/chats"');
  expect(line).not.toContain("TESTONLY-secret");
  expect(line).not.toContain(token);

  // And the page sends at most 10 reports, and the same error twice is one report
  await page.evaluate(() => {
    for (let i = 0; i < 30; i++) setTimeout(() => { throw new Error(i < 5 ? "TESTONLY same" : `TESTONLY many ${i}`); }, 0);
  });
  await expect.poll(() => lines(u.w.srv).length, { timeout: 15_000 }).toBe(10);
  await page.waitForTimeout(1_000);
  expect(lines(u.w.srv)).toHaveLength(10);
  expect(lines(u.w.srv).filter((l) => l.includes("TESTONLY same"))).toHaveLength(1);
});

scenario("An error in the service worker reaches the server log", { tag: ["@browser"] }, async ({ server, page, context }) => {
  // Background: a fresh Convoz server with owner "drew" signed in in a browser
  const u = await uiWorld({ server, page, context });
  await createConversation(u.w.owner, { participants: ["devtool"], title: TITLE });

  // Given the owner has the chat list open and the app's service worker is running
  await page.goto(`${u.w.srv.origin}/chats`);
  await expect(page.getByRole("link", { name: new RegExp(TITLE) }).first()).toBeVisible();
  await expect.poll(() => context.serviceWorkers().length, { timeout: 15_000 }).toBeGreaterThan(0);

  // When a script error that nothing catches happens in the service worker
  await context.serviceWorkers()[0]!.evaluate(() => void setTimeout(() => { throw new Error("TESTONLY worker boom"); }, 0));

  // Then the server log has one "client_error" line with the error's message and the page "/sw.js"
  const line = await lineWith(u.w.srv, "TESTONLY worker boom");
  expect(line).toContain(' page="/sw.js"');
  expect(lines(u.w.srv).filter((l) => l.includes("TESTONLY worker boom"))).toHaveLength(1);
});
