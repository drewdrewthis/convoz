import { agentPost, convoz, ownerSays, startSession } from "../lib/chat.ts";
import { signInBrowser } from "../lib/machines.ts";
import { leaseOf, msgWorld } from "../lib/messages-wp4.ts";
import { send } from "../lib/http.ts";
import { must } from "../lib/owner.ts";
import { expect, scenario } from "../lib/scenario.ts";
import { agentCard, github, ownerCard, PULL, resolveTo, serve, settledCard, site } from "../lib/unfurl-wp15.ts";

/*
 * LINK UNFURL (WP15): specs/features/messages-types.feature and specs/contracts/messages-types.feature, rule "Links show a preview to
 * people, the address to agents". The route, the setting and the test build's site fixtures are described atop lib/unfurl-wp15.ts.
 * The card is made by a worker after the post commits, so a scenario waits for it (settledCard) before it asserts what it holds.
 */

const PR = "https://github.com/acme/app/pull/415";

scenario("A link shows a preview card", { tag: ["@browser"] }, async ({ server, dataDir, page, context }) => {
  // Background: conversation 41 "Ship search filters" with "devtool", the owner signed in on the web
  const w = await msgWorld({ server, dataDir });
  await signInBrowser(w.srv, w.owner, page, context);
  const gh = await github();
  try {
    // Given unfurls are on for "github.com" (every public host is; the site stands in for it)
    await serve(w.srv, gh, "github.com", "api.github.com");

    // When "devtool" posts "https://github.com/acme/app/pull/415" in conversation 41
    const lease = await leaseOf(w, "devtool");
    must(await agentPost(w.srv, lease, w.conv, PR), "post the link", 201);
    await page.goto(`${w.srv.origin}/chats/${w.conv}`);

    // Then the owner sees a card with the pull request title and its state
    const card = page.getByRole("group", { name: "Link preview" });
    await expect(card.getByRole("link", { name: PULL.title })).toBeVisible({ timeout: 20_000 });
    await expect(card.getByText("Open", { exact: true })).toBeVisible();
    await expect(card).toContainText("acme/app");
    await expect(card.getByRole("link", { name: PULL.title })).toHaveAttribute("href", PR);

    // And hiding it leaves the Preview button, which brings it back
    await card.getByRole("button", { name: "Hide preview" }).click();
    await expect(card).toHaveCount(0);
    await page.getByRole("button", { name: "Preview", exact: true }).click();
    await expect(card).toBeVisible();
  } finally {
    await gh.close();
  }
});

scenario("An agent gets the link, not the fetched page", { tag: ["@cli"] }, async ({ server, dataDir }) => {
  // Background: conversation 41 "Ship search filters" with "devtool"
  const w = await msgWorld({ server, dataDir });
  const gh = await github();
  try {
    // Given unfurls are on for "github.com" (every public host is; the site stands in for it)
    await serve(w.srv, gh, "github.com", "api.github.com");
    const dev = await startSession(w.box, "devtool", "s1");

    // When the owner posts "@devtool see https://github.com/acme/app/pull/415" in conversation 41
    const id = await ownerSays(w.owner, w.conv, `@devtool see ${PR}`);
    const made = await settledCard(w.owner, id);
    expect(made, "the server holds the card the owner sees").toMatchObject({ status: "ok", title: PULL.title, meta: { state: "open" } });

    // Then "convoz read 41" as "devtool" shows the address and no card content
    const read = await convoz(w.box, dev.sid, ["read", String(w.conv)]);
    expect(read.code).toBe(0);
    expect(read.stdout).toContain(PR);
    for (const content of [PULL.title, "Caps retries", "GitHub"]) expect(read.stdout, `read shows ${content}`).not.toContain(content);
    const json = await convoz(w.box, dev.sid, ["read", "--json", String(w.conv)]);
    expect(json.stdout).toContain(PR);
    expect(json.stdout).not.toContain(PULL.title);

    // And the card route is closed to the agent itself, so the page content cannot reach it by that way either
    const asked = await agentCard(w.srv, dev.lease, id);
    expect(asked.status).toBe(403);
    expect(asked.json().error.code).toBe("agent_gets_link_only");
    expect(asked.text).not.toContain(PULL.title);
  } finally {
    await gh.close();
  }
});

scenario("An unfurl card is served only to those who can see the message", { tag: ["@api"] }, async ({ server, dataDir }) => {
  // Background: conversation 41 "Ship search filters" with "devtool"; "docs" is not in it
  const w = await msgWorld({ server, dataDir, participants: ["devtool"] });
  const gh = await github();
  try {
    // Given "devtool" posted "https://github.com/acme/app/pull/415" in conversation 41
    // Given unfurls are on for "github.com" (every public host is; the site stands in for it)
    await serve(w.srv, gh, "github.com", "api.github.com");
    const dev = await leaseOf(w, "devtool");
    const posted = must(await agentPost(w.srv, dev, w.conv, PR), "post the link", 201).json();
    const id = (posted.message?.id ?? posted.id) as number;
    expect((await settledCard(w.owner, id)).status).toBe("ok");

    // When "docs", who is not in conversation 41, asks GET /api/messages/:id/unfurl
    const docs = await leaseOf(w, "docs");
    const res = await agentCard(w.srv, docs, id);

    // Then the server answers 403
    expect(res.status).toBe(403);
    expect(res.json().error.code, "refused because docs cannot see the message").toBe("forbidden");
    expect(res.text).not.toContain(PULL.title);

    // And the owner, who sees everything, gets the card; an agent in the conversation is told the address only; nobody without credentials gets it
    expect((await ownerCard(w.owner, id)).status).toBe(200);
    expect((await agentCard(w.srv, dev, id)).status).toBe(403);
    expect((await send(w.srv.target, "GET", `/api/messages/${id}/unfurl`)).status).toBe(401);
  } finally {
    await gh.close();
  }
});

scenario("The unfurl worker never fetches a private address", { tag: ["@api"] }, async ({ server, dataDir }) => {
  // Background: conversation 41 "Ship search filters" with "devtool"
  const w = await msgWorld({ server, dataDir });
  // The test listener: a real server on 127.0.0.1 that counts every request it gets
  const listener = await site((_req, res) => res.end("<title>private</title>"), 7788).catch(() => site((_req, res) => res.end("<title>private</title>")));
  // A public page, and a public page that redirects to localhost
  const open = await site((_req, res) => {
    res.setHeader("content-type", "text/html");
    res.end("<title>Public page</title>");
  });
  const bouncer = await site((_req, res) => {
    res.statusCode = 302;
    res.setHeader("location", `http://localhost:${listener.port}/secret`);
    res.end();
  });
  try {
    await serve(w.srv, open, "open.test");
    await serve(w.srv, bouncer, "bounce.test");
    await resolveTo(w.srv, "inside.test", "10.0.0.5");

    // Control: a public page does get its card, so "unavailable" below is the guard and not a worker that never runs
    const control = await settledCard(w.owner, await ownerSays(w.owner, w.conv, "control http://open.test/page"));
    expect(control).toMatchObject({ status: "ok", title: "Public page" });

    const rows: [string, string][] = [
      ["http://127.0.0.1:7788/", `http://127.0.0.1:${listener.port}/`],
      ["http://169.254.169.254/latest/meta-data/", "http://169.254.169.254/latest/meta-data/"],
      ["a host name that resolves to 10.0.0.5", "http://inside.test/admin"],
      ["a public page that redirects to localhost", "http://bounce.test/start"],
    ];
    for (const [target, link] of rows) {
      // When a message links to <target>
      const id = await ownerSays(w.owner, w.conv, `look ${link}`);

      // Then the unfurl ends "unavailable" and the test listener on that address gets no request
      const card = await settledCard(w.owner, id);
      expect(card.status, target).toBe("unavailable");
      expect(card.title, target).toBeUndefined();
    }
    expect(listener.hits, "the private listener was reached").toEqual([]);
    expect(open.hits, "only the control fetched the public page").toEqual(["GET /page"]);
    expect(bouncer.hits, "the public page was asked once, then its redirect was refused").toEqual(["GET /start"]);
  } finally {
    await Promise.all([listener.close(), open.close(), bouncer.close()]);
  }
});
