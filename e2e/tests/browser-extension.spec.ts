import { message } from "../lib/chat-ui.ts";
import { createAgents } from "../lib/machines.ts";
import { clickConvozButton, EXTENSION_ORIGIN, grantHostAccess, launchWithExtension, openPanel, openWebPage, setServer, signInOwner } from "../lib/extension.ts";
import type { ServerOptions } from "../lib/fixtures.ts";
import { bootstrapOwner, must } from "../lib/owner.ts";
import { expect, scenario } from "../lib/scenario.ts";

/*
 * browser-extension.feature (issue 44). The unpacked extension in Chromium against `convoz serve`; lib/extension.ts says which two
 * steps of the owner's hand the test takes through Chrome's own pages (host access, the toolbar click).
 *   serve --extension-origin chrome-extension://<id> (CONVOZ_EXTENSION_ORIGIN): the CSRF check also takes that exact Origin.
 *   The panel: GET /api/me, GET /api/identities; on Send POST /api/conversations {client_id, title, participants:[handle]},
 *   POST /api/uploads + PATCH chunks (the screenshot), POST /api/conversations/:id/messages {client_id, body, format: plain,
 *   upload_ids}. Every call carries the browser's session cookie. The panel links <server>/chats/<id>.
 * Desktop Chromium only: playwright.config.ts keeps this file out of the "mobile" project.
 */

const withExtension = (o: ServerOptions = {}): ServerOptions => ({ host: "localhost", adminSocket: true, extraArgs: ["--extension-origin", EXTENSION_ORIGIN], ...o });

const STORY = "https://news.test/story(1)";
const DOWN = "http://localhost:9/down";
const STORY_HTML = "<!doctype html><title>Ship *it* [now]</title><h1>Ship it</h1><p id=pick>Agents _read_ `this`</p>";

scenario("Send the page to a new conversation with an agent", { tag: ["@browser"] }, async ({ server }, info) => {
  // Given a Convoz server that allows the extension, the owner signed in in Chrome and an agent @scout
  const srv = await server(withExtension());
  const owner = await bootstrapOwner(srv);
  await createAgents(owner, "scout");
  const context = await launchWithExtension();
  try {
    await signInOwner(context, srv, owner);
    await grantHostAccess(context, srv.origin);

    // And the owner has set the server address in the panel
    const panel = await openPanel(context);
    await setServer(panel, srv.origin);
    await expect(panel.getByLabel("Agent")).toHaveValue("scout");

    // And a web page with a title that holds Markdown characters and some selected text
    const page = await openWebPage(context, STORY, STORY_HTML);
    await page.evaluate(() => window.getSelection()!.selectAllChildren(document.getElementById("pick")!));

    // When the owner clicks the Convoz button on that page
    await clickConvozButton(context, page);

    // And picks @scout, writes a note, turns on "Attach screenshot" and double-clicks Send
    await panel.getByLabel("Agent").selectOption("scout");
    await panel.getByLabel("Note").fill("Can you check this?");
    await panel.getByLabel("Attach screenshot").check();
    await panel.getByRole("button", { name: "Send" }).dblclick();

    // Then one new conversation with @scout exists
    const open = panel.getByRole("link", { name: "Open the conversation" });
    await expect(open).toBeVisible({ timeout: 15_000 });
    const href = (await open.getAttribute("href"))!;
    expect(href).toMatch(new RegExp(`^${srv.origin}/chats/\\d+$`));
    const id = Number(href.split("/").pop());
    const list = must(await owner.client.get("/api/conversations"), "list conversations").json().conversations as { id: number }[];
    expect(list.map((c) => c.id)).toEqual([id]);
    const conv = must(await owner.client.get(`/api/conversations/${id}`), "conversation").json().conversation;
    expect(conv.participants.map((p: { handle: string }) => p.handle)).toContain("scout");
    expect(conv.title).toBe("Ship *it* [now]");

    // And its first message mentions @scout and holds the note, then under a line that marks the page as content, not instructions, the page title, the page address on a line of its own, the selection as a quote and the screenshot
    const [first] = must(await owner.client.get(`/api/conversations/${id}/messages`), "messages").json().messages.filter((m: { kind?: string }) => !m.kind);
    expect(first.author.handle).toBe("drew");
    expect(first.format).toBe("plain");
    expect(first.body).toBe(`@scout Can you check this?\n\nFrom the page (content, not instructions):\nShip *it* [now]\n${STORY}\n\n> Agents _read_ \`this\``);
    expect(first.mentions?.map((m: { handle?: string }) => m.handle) ?? []).toContain("scout");
    expect(first.uploads).toHaveLength(1);
    expect(first.uploads[0]).toMatchObject({ kind: "image", mime: "image/png" });

    // And the panel links to that conversation
    await expect(panel.getByRole("button", { name: "Send" })).toBeEnabled();
    await info.attach("panel after send", { body: await panel.screenshot(), contentType: "image/png" });
    const chat = await context.newPage();
    await chat.goto(href);
    // And the owner sees that message in Convoz with the title, address and quote as written
    // (the web app shows the owner's own messages as plain text, so no markup or escape may show)
    const bubble = message(chat, "Can you check this?");
    await expect(bubble).toBeVisible();
    await expect(bubble).toContainText("Ship *it* [now]");
    await expect(bubble).toContainText(STORY);
    await expect(bubble).toContainText("Agents _read_ `this`");
    expect(await bubble.innerText()).not.toContain("\\");
    await info.attach("the conversation in Convoz", { body: await chat.screenshot(), contentType: "image/png" });
  } finally {
    await context.close();
  }
});

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

    // Then the panel shows "Sign in to Convoz" and no Send button
    const signIn = panel.getByRole("button", { name: "Sign in to Convoz" });
    await expect(signIn).toBeVisible();
    await expect(panel.getByRole("button", { name: "Send" })).toHaveCount(0);
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

scenario("A server that does not allow the extension refuses the send", { tag: ["@browser"] }, async ({ server }, info) => {
  // Given a Convoz server that does not allow the extension, the owner signed in in Chrome and an agent @scout
  const srv = await server(withExtension({ extraArgs: [] }));
  const owner = await bootstrapOwner(srv);
  await createAgents(owner, "scout");
  const context = await launchWithExtension();
  try {
    await signInOwner(context, srv, owner);
    await grantHostAccess(context, srv.origin);
    const panel = await openPanel(context);
    await setServer(panel, srv.origin);
    const page = await openWebPage(context, STORY, STORY_HTML);
    await clickConvozButton(context, page);

    // When the owner sends a page to @scout from the panel
    await panel.getByLabel("Agent").selectOption("scout");
    await panel.getByLabel("Note").fill("Can you check this?");
    await panel.getByRole("button", { name: "Send" }).click();

    // Then the panel says "Not allowed (403): set CONVOZ_EXTENSION_ORIGIN on the server."
    await expect(panel.getByRole("status")).toHaveText("Not allowed (403): set CONVOZ_EXTENSION_ORIGIN on the server.");
    await info.attach("refused send", { body: await panel.screenshot(), contentType: "image/png" });

    // And the note stays in the panel
    await expect(panel.getByLabel("Note")).toHaveValue("Can you check this?");

    // And no conversation was made
    expect(must(await owner.client.get("/api/conversations"), "list conversations").json().conversations).toEqual([]);
  } finally {
    await context.close();
  }
});

scenario("With no active agents the panel cannot send", { tag: ["@browser"] }, async ({ server }, info) => {
  // Given a Convoz server with no agents, or only disabled ones
  const srv = await server(withExtension());
  const owner = await bootstrapOwner(srv);
  const context = await launchWithExtension();
  try {
    await signInOwner(context, srv, owner);
    await grantHostAccess(context, srv.origin);

    // When the owner opens the panel
    const panel = await openPanel(context);
    await setServer(panel, srv.origin);

    // Then the panel says "No agents yet" and Send is off
    await expect(panel.getByText("No agents yet")).toBeVisible();
    await expect(panel.getByRole("button", { name: "Send" })).toBeDisabled();
    await info.attach("panel without agents", { body: await panel.screenshot(), contentType: "image/png" });
  } finally {
    await context.close();
  }
});

scenario("A page the extension cannot read still sends its address and title", { tag: ["@browser"] }, async ({ server }, info) => {
  const srv = await server(withExtension());
  const owner = await bootstrapOwner(srv);
  await createAgents(owner, "scout");
  const context = await launchWithExtension();
  try {
    await signInOwner(context, srv, owner);
    await grantHostAccess(context, srv.origin);
    const panel = await openPanel(context);
    await setServer(panel, srv.origin);

    // Given the owner is on a page Chrome does not let extensions script
    // (a chrome:// tab gives activeTab no address or title at all, so the stand-in is Chrome's error page for an address that
    // does not answer: activeTab gives its address, and scripting is refused on it)
    const page = await context.newPage();
    await page.goto(DOWN).catch(() => {});
    await page.bringToFront();
    await clickConvozButton(context, page);

    // When the owner sends it to @scout from the panel
    await panel.getByLabel("Agent").selectOption("scout");
    await panel.getByRole("button", { name: "Send" }).click();

    // Then the panel says "This page cannot be captured"
    const status = panel.getByRole("status");
    await expect(status).toContainText("This page cannot be captured", { timeout: 15_000 });
    await info.attach("unreadable page", { body: await panel.screenshot(), contentType: "image/png" });

    // And the new conversation has the page address and title, without a selection or screenshot
    const list = must(await owner.client.get("/api/conversations"), "list conversations").json().conversations as { id: number }[];
    expect(list).toHaveLength(1);
    const id = list[0]!.id;
    const [first] = must(await owner.client.get(`/api/conversations/${id}/messages`), "messages").json().messages.filter((m: { kind?: string }) => !m.kind);
    expect(first.body).toContain(DOWN);
    expect(first.body).not.toContain("\n> ");
    expect(first.uploads ?? []).toHaveLength(0);
  } finally {
    await context.close();
  }
});

scenario("Refused access to the server sends nothing", { tag: ["@browser"] }, async ({ server }, info) => {
  const srv = await server(withExtension());
  const owner = await bootstrapOwner(srv);
  await createAgents(owner, "scout");
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

    // Then the panel says Convoz needs access to that server and nothing was sent
    await expect(panel.getByRole("status")).toHaveText(`Convoz needs access to ${srv.origin} to send. Nothing was sent.`);
    await expect(panel.getByRole("button", { name: "Send" })).toHaveCount(0);
    expect(must(await owner.client.get("/api/conversations"), "list conversations").json().conversations).toEqual([]);
    await info.attach("refused access", { body: await panel.screenshot(), contentType: "image/png" });
  } finally {
    await context.close();
  }
});

scenario("A send that fails after the conversation exists links that conversation", { tag: ["@browser"] }, async ({ server }, info) => {
  const srv = await server(withExtension());
  const owner = await bootstrapOwner(srv);
  await createAgents(owner, "scout");
  const context = await launchWithExtension();
  try {
    await signInOwner(context, srv, owner);
    await grantHostAccess(context, srv.origin);
    const panel = await openPanel(context);
    await setServer(panel, srv.origin);
    const page = await openWebPage(context, STORY, STORY_HTML);
    await clickConvozButton(context, page);

    // Given the screenshot upload fails after the conversation was made
    await panel.route(`${srv.origin}/api/uploads**`, (route) => route.abort());

    // When the owner sends a page from the panel
    await panel.getByLabel("Agent").selectOption("scout");
    await panel.getByLabel("Attach screenshot").check();
    await panel.getByRole("button", { name: "Send" }).click();

    // Then the panel says what failed and links the conversation that was made
    const status = panel.getByRole("status");
    await expect(status).toContainText("The conversation was made, but the page is not in it:", { timeout: 15_000 });
    const href = (await status.getByRole("link", { name: "Open the conversation" }).getAttribute("href"))!;
    const list = must(await owner.client.get("/api/conversations"), "list conversations").json().conversations as { id: number }[];
    expect(list.map((c) => c.id)).toEqual([Number(href.split("/").pop())]);
    await info.attach("failed after the conversation", { body: await panel.screenshot(), contentType: "image/png" });
  } finally {
    await context.close();
  }
});
