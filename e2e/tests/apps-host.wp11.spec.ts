import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { convoz, inboxItems, messagesOf, ownerSays } from "../lib/chat.ts";
import { McpClient } from "../lib/agent-wp7.ts";
import { agentPost } from "../lib/chat.ts";
import { send } from "../lib/http.ts";
import { bearer, clientId, plainDb } from "../lib/machines.ts";
import { must } from "../lib/owner.ts";
import { repoRoot } from "../lib/paths.ts";
import { expect, scenario, test } from "../lib/scenario.ts";
import { askBody, askOf, postAsk } from "../lib/asks.ts";
import {
  FRAME_CSP,
  appCard,
  appFrame,
  appsWorld,
  consoleErrors,
  examples,
  frameApp,
  frameHtml,
  identityId,
  openApp,
  openConversation,
  ownerResult,
  padded,
  pageOf,
  pickerResult,
  png,
  postApp,
  postAppRaw,
  postFrame,
  putFile,
  requestLog,
  resultSheet,
  rowCounts,
  stored,
  thread,
  validApp,
  viaAppRows,
} from "../lib/apps-wp11.ts";
import { closeThread, openThread, threadLog } from "../lib/threads-wp5.ts";

/*
 * APPS INSIDE MESSAGES (WP11): the bindings of specs/features/apps-host.feature and specs/contracts/apps-host.feature. The helpers and the
 * routes they call are the contract block at the top of lib/apps-wp11.ts (packages/contracts/paths/appkit.yaml). A Tier-2 test app is one HTML
 * document with the frame runtime first; the owner opens it with "Open app" and a result it sends waits on the dialog "Confirm app result".
 */

const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "convoz-wp11-"));
const write = (dir: string, name: string, content: unknown): string => {
  const file = path.join(dir, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof content === "string" ? content : JSON.stringify(content));
  return file;
};
const sha256 = (b: Buffer | string): string => crypto.createHash("sha256").update(b).digest("hex");

// ---- Rule: Agents build and check apps before they post them (apps-host.feature) -------------------------------

scenario("An agent checks an app before posting it", { tag: ["@cli"] }, async ({ server }) => {
  // Background
  const a = await appsWorld({ server });
  const before = (await pageOf(a)).length;

  // When "devtool" runs "convoz app validate pick.json" on a picker with one option
  const app = validApp("picker-single-prototype-a2");
  app.props.options = app.props.options.slice(0, 1);
  const file = write(tmp(), "pick.json", app);
  const ran = await convoz(a.w.box, a.devtool.sid, ["app", "validate", file]);

  // Then the CLI exits 2 and prints "/props/options: must have at least 2 items"
  expect(ran.code).toBe(2);
  expect(ran.stderr + ran.stdout).toContain("/props/options: must have at least 2 items");

  // And nothing is posted
  expect((await pageOf(a)).length).toBe(before);
});

scenario("A typo in an app is caught at post time", { tag: ["@cli"] }, async ({ server }) => {
  // Background
  const a = await appsWorld({ server });
  const before = (await pageOf(a)).length;

  // When "devtool" runs "convoz post 41 --app chart.json Tokens" with the key "colour" in the props
  const app = validApp("chart-bar-prototype-a1");
  app.props.colour = "red";
  const file = write(tmp(), "chart.json", app);
  const ran = await convoz(a.w.box, a.devtool.sid, ["post", "--app", file, String(a.conv), "Tokens"]);

  // Then the CLI exits 2 naming "/props/colour"
  expect(ran.code).toBe(2);
  expect(ran.stderr).toContain("/props/colour");

  // And conversation 41 shows no new message
  expect((await pageOf(a)).length).toBe(before);
});

/** The source folder "deploy-report" with "convoz.app.json" and "index.html", inside the machine's home. */
function deployReport(home: string, index?: string): void {
  const dir = path.join(home, "deploy-report");
  write(dir, "convoz.app.json", { name: "Deploy report", version: "1.0.0", icon: "report", height: { initial: 130, min: 80, max: 400 }, results: true, permissions: [] });
  write(
    dir,
    "index.html",
    index ??
      `<!doctype html>\n<meta charset="utf-8">\n<table id="t"></table>\n<button id="rb">Roll back box-3 again</button>\n<script>\n  convoz.onInit(({ data }) => {\n    document.getElementById("t").textContent = data.rows.length + " rows";\n    convoz.fit();\n  });\n  document.getElementById("rb").onclick = () => convoz.result({ summary: "Roll back box-3 again", value: { action: "rollback" } });\n</script>\n`,
  );
}

scenario("An agent builds a Tier-2 app without npm", { tag: ["@cli", "@mcp"] }, async ({ server }) => {
  // Background
  const a = await appsWorld({ server });

  // Given the source folder "deploy-report" with "convoz.app.json" and "index.html"
  deployReport(a.w.box.home);

  // When "devtool" runs "convoz app build ./deploy-report"
  const built = await convoz(a.w.box, a.devtool.sid, ["app", "build", "./deploy-report"]);
  expect(built.code).toBe(0);

  // Then it writes "dist/app.html" and "dist/app.json" and prints the size and SHA-256
  const html = fs.readFileSync(path.join(a.w.box.home, "deploy-report", "dist", "app.html"));
  const envelope = JSON.parse(fs.readFileSync(path.join(a.w.box.home, "deploy-report", "dist", "app.json"), "utf8"));
  expect(built.stdout).toContain(`${html.length} bytes`);
  expect(built.stdout).toContain(sha256(html));
  expect(envelope.props.bundle).toEqual({ file: "app.html" });
  expect(html.toString()).toContain("window.convoz");

  // And "convoz post 41 --app deploy-report/dist/app.json --app-fallback 'Deploy report for box-3' Report" posts it
  const posted = await convoz(a.w.box, a.devtool.sid, ["post", "--app", "deploy-report/dist/app.json", "--app-fallback", "Deploy report for box-3", String(a.conv), "Report"]);
  expect(posted.code).toBe(0);
  const message = (await pageOf(a)).find((m) => m.body === "Report");
  expect(message?.app).toMatchObject({ type: "frame", fallback: "Deploy report for box-3", props: { bundle: { size: html.length, sha256: sha256(html) } } });

  // And the same build runs as the MCP tool app_build
  const mcp = await McpClient.start(a.w.box, "devtool", "claude-TESTONLY-mcp-build");
  const tool = await mcp.tool("app_build", { dir: "./deploy-report" });
  mcp.end();
  expect(tool.isError ?? false).toBe(false);
  expect(tool.content.map((c) => c.text).join("\n")).toContain(sha256(html));
});

scenario("A Tier-2 build refuses outside links", { tag: ["@cli"] }, async ({ server }) => {
  // Background
  const a = await appsWorld({ server });

  // Given "deploy-report/index.html" loads "https://cdn.example/x.js"
  deployReport(a.w.box.home, `<!doctype html>\n<meta charset="utf-8">\n<p>Report</p>\n<script src="https://cdn.example/x.js"></script>\n`);

  // When "devtool" runs "convoz app build ./deploy-report"
  const built = await convoz(a.w.box, a.devtool.sid, ["app", "build", "./deploy-report"]);

  // Then the CLI exits 2 with "app_bundle_external_ref" and the file and line
  expect(built.code).toBe(2);
  expect(built.stderr).toContain("app_bundle_external_ref: index.html:4:");
  expect(fs.existsSync(path.join(a.w.box.home, "deploy-report", "dist", "app.html"))).toBe(false);
});

// ---- Rule: Tier-1 apps are our own components fed with data (contracts) -----------------------------------------

scenario("An app with unknown keys is refused", { tag: ["@api"] }, async ({ server, dataDir }) => {
  // Background
  const a = await appsWorld({ server });
  const tables = ["messages", "events", "search_entries", "inbox_items"];
  const before = rowCounts(dataDir, tables);

  // When "devtool" posts a Tier-1 chart app with an extra key "onload"
  const app = validApp("chart-bar-prototype-a1");
  app.props.onload = "alert(1)";
  const res = await postAppRaw(a, app, "Tokens");

  // Then the server answers 400 with the code "app_invalid" and the path "/props/onload"
  expect(res.status).toBe(400);
  expect(res.json().error).toMatchObject({ code: "app_invalid", path: "/props/onload" });

  // And no message, event, search entry or inbox item was written
  expect(rowCounts(dataDir, tables)).toEqual(before);
});

/** A table app whose compact JSON is exactly `size` bytes: 12 columns of 200-character cells, the last row sized to fit. */
function tableOfSize(size: number): any {
  const app: any = {
    v: 1,
    type: "table",
    title: "Big",
    fallback: "A big table.",
    props: { columns: Array.from({ length: 12 }, (_, i) => ({ label: `C${i}` })), rows: [] },
  };
  const bytes = () => Buffer.byteLength(JSON.stringify(app));
  while (bytes() < size) {
    const r = Array.from({ length: 12 }, () => "x");
    app.props.rows.push(r);
    for (let i = 0; bytes() < size && r.some((c) => c.length < 200); i = (i + 1) % 12) if (r[i]!.length < 200) r[i] += "x"; // one character at a time: the size is hit exactly
  }
  return app;
}

scenario("App size limits are exact", { tag: ["@api"] }, async ({ server }) => {
  // Background
  const a = await appsWorld({ server });
  const body = (n: number) => `m${n}`;

  // an app of exactly 65536 bytes | accepts it
  const exact = tableOfSize(65536);
  expect(Buffer.byteLength(JSON.stringify(exact))).toBe(65536);
  expect((await postAppRaw(a, exact, body(1))).status).toBe(201);

  // an app of 65537 bytes | answers 400 with the code "app_too_large"
  const over = tableOfSize(65537);
  expect(Buffer.byteLength(JSON.stringify(over))).toBe(65537);
  const tooBig = await postAppRaw(a, over, body(2));
  expect(tooBig.status).toBe(400);
  expect(tooBig.json().error.code).toBe("app_too_large");

  // a Tier-2 bundle upload of 524288 bytes | accepts it
  const html = frameHtml("<p>big</p>");
  expect((await putFile(a.w.srv, a.devtool.lease, padded(html, 524288))).status).toBe(200);

  // a Tier-2 bundle upload of 524289 bytes | refuses it at upload
  const refused = await putFile(a.w.srv, a.devtool.lease, padded(html, 524289));
  expect(refused.status).toBe(413);
  expect(refused.json().error.code).toBe("app_too_large");

  // frame data of 32769 bytes | answers 400 with the code "app_too_large"
  const bundle = await stored(a.w.srv, a.devtool.lease, Buffer.from(html));
  const bigData = await postAppRaw(a, frameApp(bundle, { data: "d".repeat(32769 - 2) }), body(3));
  expect(bigData.status).toBe(400);
  expect(bigData.json().error).toMatchObject({ code: "app_too_large", path: "/props/data" });
});

scenario("Apps that act cannot sit on an ask", { tag: ["@api"] }, async ({ server }) => {
  // Background
  const a = await appsWorld({ server });
  const checklist = validApp("checklist-select");
  const rows: [string, any][] = [
    ["a picker", validApp("picker-single-prototype-a2")],
    ["a form", validApp("form")],
    ["a checklist in select mode", checklist],
  ];
  for (const [what, app] of rows) {
    // When "devtool" posts an ask with <app>
    const res = await postAsk(a.w.srv, a.devtool.lease, { ...askBody(a.conv, { question: `Which, ${what}?` }), app });

    // Then the server answers 400 with the code "app_type_not_allowed_on_ask"
    expect({ what, status: res.status, code: res.json().error?.code }).toEqual({ what, status: 400, code: "app_type_not_allowed_on_ask" });
  }
});

scenario("An app over 4 KB is a stub in the message page", { tag: ["@api"] }, async ({ server }) => {
  // Background
  const a = await appsWorld({ server });

  // Given "devtool" posted a chart app whose props are 20 KB
  const app = validApp("chart-bar-prototype-a1");
  const labels = Array.from({ length: 500 }, (_, i) => `d${i}`);
  app.props.x.labels = labels;
  app.props.series = Array.from({ length: 5 }, (_, s) => ({ name: `Lane ${s}`, values: labels.map((_l, i) => 1000 + i * 3 + s + 0.5), tone: "accent" }));
  expect(Buffer.byteLength(JSON.stringify(app.props))).toBeGreaterThan(19_000);
  const id = await postApp(a, app, "Tokens");

  // When the owner loads the messages page of conversation 41
  const message = (await pageOf(a)).find((m) => m.id === id);

  // Then the app appears as a stub with type, version, title, fallback and size
  expect(message?.app).toEqual({ stub: true, v: 1, type: "chart", title: "Tokens per day", fallback: app.fallback, bytes: Buffer.byteLength(JSON.stringify(app)) });

  // And GET /api/messages/:id/app returns the full app
  const full = must(await a.w.owner.client.get(`/api/messages/${id}/app`), "read the app").json();
  expect(full).toEqual({ app });
});

scenario("A result must match its app", { tag: ["@api"] }, async ({ server }) => {
  // Background
  const a = await appsWorld({ server });

  // Given the picker app of "devtool" offers "builtin", "vitest" and "jest"
  const id = await postApp(a, validApp("picker-single-prototype-a2"), "Pick");

  // When the owner sends a via_app result that selects "mocha"
  const res = await ownerResult(a, id, pickerResult(["mocha"]));

  // Then the server answers 400 with the code "app_result_invalid"
  expect(res.status).toBe(400);
  expect(res.json().error.code).toBe("app_result_invalid");
});

scenario("A via_app message must come from a person and point at that agent's app", { tag: ["@api", "@invariant"] }, async ({ server, dataDir }) => {
  // Background
  const a = await appsWorld({ server });
  const devtool = identityId(dataDir, "devtool");
  const docs = identityId(dataDir, "docs");
  const owner = identityId(dataDir, "drew");
  const pickerOfDevtool = await postApp(a, validApp("picker-single-prototype-a2"), "Pick one");
  const pickerOfDocs = await postApp(a, validApp("picker-single-prototype-a2"), "Pick another", {}, a.docs.lease);
  const plainOfDevtool = Number(must(await agentPost(a.w.srv, a.devtool.lease, a.conv, "Just words"), "plain message", 201).json().id);
  const result = JSON.stringify(pickerResult(["vitest"]));

  /** The row written straight into the data file, as a build that skips the app checks would: the database must still refuse it. */
  const direct = (author: number, agent: number, target: number): string => {
    const db = plainDb(dataDir);
    try {
      db.prepare(
        "INSERT INTO messages (conversation_id, author_id, kind, format, body, via_app_agent_id, via_app_message_id, app_result_json, created_at) VALUES (?, ?, 'text', 'plain', 'Picked vitest', ?, ?, ?, ?)",
      ).run(a.conv, author, agent, target, result, Date.now());
      return "written";
    } catch (e) {
      return String(e);
    } finally {
      db.close();
    }
  };

  // the "devtool" lease | the picker app of "devtool"
  // When <sender> sends a via_app message that points at <target>
  const lease = await agentPost(a.w.srv, a.devtool.lease, a.conv, "Picked vitest", { via_app: { message_id: pickerOfDevtool, result: pickerResult(["vitest"]) } });
  // Then the request is refused
  expect(lease.status).toBe(403);
  // And the refusal holds even when the test build skips the app checks and writes the row directly
  expect(direct(devtool, devtool, pickerOfDevtool)).toContain("via_app needs a human sender");

  // the owner | a plain text message of "devtool"
  const plain = await ownerResult(a, plainOfDevtool, pickerResult(["vitest"]));
  expect([plain.status, plain.json().error.code]).toEqual([400, "app_result_not_allowed"]);
  expect(direct(owner, devtool, plainOfDevtool)).toContain("via_app needs a human sender");

  // the owner | the app of "docs" while naming "devtool"
  const naming = await ownerResult(a, pickerOfDocs, pickerResult(["vitest"]), { via_app: { message_id: pickerOfDocs, agent: "devtool", result: pickerResult(["vitest"]) } });
  expect(naming.status).toBe(400);
  expect(direct(owner, devtool, pickerOfDocs)).toContain("via_app needs a human sender");
  expect(direct(owner, docs, pickerOfDocs)).toBe("written"); // the same row with the right agent is the one the database accepts
  expect(viaAppRows(dataDir).map((r) => [r.author_id, r.via_app_agent_id, r.via_app_message_id])).toEqual([[owner, docs, pickerOfDocs]]);
});

scenario("The frame route serves only the right bundle to the right caller", { tag: ["@api"] }, async ({ server }) => {
  // Background
  const a = await appsWorld({ server });

  // Given a Tier-2 app
  const html = frameHtml("<p>frame</p>");
  const id = await postFrame(a, html, { title: "Frame route" });
  const hash = sha256(html);
  const iframe = { "Sec-Fetch-Dest": "iframe" };
  const frame = (h: string, headers: Record<string, string>) => a.w.owner.client.get(`/api/apps/${id}/frame?h=${h}`, { headers });

  // the owner's browser | with the right hash, as an iframe | 200 with the exact frame CSP
  const ok = await frame(hash, iframe);
  expect(ok.status).toBe(200);
  expect(ok.headers["content-security-policy"]).toBe(FRAME_CSP);
  expect(ok.headers["x-content-type-options"]).toBe("nosniff");
  expect(ok.text).toBe(html);

  // the owner's browser | with a wrong hash | 404
  expect((await frame("0".repeat(64), iframe)).status).toBe(404);

  // the "devtool" lease | with the right hash | 403
  expect((await send(a.w.srv.target, "GET", `/api/apps/${id}/frame?h=${hash}`, { headers: { ...iframe, ...bearer(a.devtool.lease).headers } })).status).toBe(403);

  // the owner's browser | without "Sec-Fetch-Dest: iframe" | 400
  expect((await frame(hash, {})).status).toBe(400);

  // the owner's browser | for a deleted message | 404
  must(await a.w.owner.client.del(`/api/messages/${id}`), "delete the app message");
  expect((await frame(hash, iframe)).status).toBe(404);
});

// ---- Rule: Tier-1 apps are our own components fed with data (apps-host.feature) -------------------------------

scenario("A Tier-1 app renders from its data", { tag: ["@browser"] }, async ({ server, page, context }, info) => {
  info.setTimeout(90_000);
  // Background
  const a = await appsWorld({ server, page, context, browser: true });
  const first = await stored(a.w.srv, a.devtool.lease, png(200, 40, 40), "image");
  const second = await stored(a.w.srv, a.devtool.lease, png(40, 200, 40), "image");
  const checklist = validApp("checklist-select");
  checklist.props.mode = "view";
  delete checklist.props.submitLabel;
  const progress = validApp("progress");
  progress.title = "Milestone 1";
  const gallery = validApp("gallery-compare");
  gallery.props.images[0].upload = first.upload;
  gallery.props.images[1].upload = second.upload;
  const apps: Record<string, any> = {
    chart: validApp("chart-bar-prototype-a1"),
    table: validApp("table"),
    code: validApp("code-diff"),
    gallery,
    kv: validApp("kv"),
    progress,
    checklist,
  };
  for (const [kit, app] of Object.entries(apps)) await postApp(a, app, `The ${kit}`);
  await openConversation(page, a.w.srv, a.conv);
  const expand = async (title: string) => {
    const card = appCard(page, title);
    await card.getByRole("button", { name: "Expand app" }).click();
    await expect(card).toHaveAttribute("data-app-state", "expanded");
    return card;
  };

  // When "devtool" posts a Tier-1 "chart" app with the fixture data
  // Then the owner sees a bar chart "Tokens per day" with a "Cap 2M a day" line in conversation 41
  const chart = await expand("Tokens per day");
  await expect(chart.getByRole("img", { name: "Tokens per day" })).toBeVisible();
  await expect(chart.locator('[data-chart="bar"]')).toBeVisible();
  await expect(chart.locator('[data-refline="Cap 2M a day"]')).toBeVisible();

  // table | a sortable table
  const table = await expand("Test runners");
  await expect(table.getByRole("table")).toBeVisible();
  const header = table.getByRole("columnheader", { name: /Time/ });
  await header.getByRole("button").click();
  await expect(header).toHaveAttribute("aria-sort", "ascending");

  // code | "Changed files" with the changed lines of a diff
  const code = await expand("Ask state guard");
  await expect(code.getByText("Changed files")).toBeVisible();
  await expect(code.locator('[data-line="add"]').first()).toBeVisible();
  await expect(code.locator('[data-line="del"]').first()).toBeVisible();

  // gallery | a before and after slider of two uploaded images
  const compare = await expand("Search bar, before and after");
  await expect(compare.getByRole("slider", { name: "Before and after" })).toBeVisible();
  for (const alt of ["Search bar before the filter chips", "Search bar with four filter chips"]) {
    const image = compare.getByRole("img", { name: alt });
    await expect(image).toBeVisible();
    await expect.poll(() => image.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBeGreaterThan(0);
  }

  // kv | key and value pairs
  const kv = await expand("box-3");
  await expect(kv.getByText("Error rate")).toBeVisible();
  await expect(kv.getByText("Rolled back")).toBeVisible();

  // progress | a progress bar with its steps
  const bar = await expand("Milestone 1");
  await expect(bar.getByRole("progressbar")).toBeVisible();
  await expect(bar.locator("li[data-step]")).toHaveCount(4);

  // checklist | a read-only checklist
  const list = await expand("Release 2.14 checks");
  await expect(list.getByRole("checkbox")).toHaveCount(4);
  for (const box of await list.getByRole("checkbox").all()) await expect(box).toBeDisabled();
});

scenario("Apps start collapsed and expand on request", { tag: ["@browser"] }, async ({ server, page, context }) => {
  // Background
  const a = await appsWorld({ server, page, context, browser: true });

  // Given "devtool" posted a Tier-1 table app
  await postApp(a, validApp("table"), "The runners");

  // When the owner opens conversation 41
  await openConversation(page, a.w.srv, a.conv);

  // Then the app shows as a collapsed card
  const card = appCard(page, "Test runners");
  await expect(card).toHaveAttribute("data-app-state", "collapsed");
  await expect(card.getByRole("table")).toHaveCount(0);

  // And "expand app" shows it in full
  await card.getByRole("button", { name: "Expand app" }).click();
  await expect(card).toHaveAttribute("data-app-state", "expanded");
  await expect(card.getByRole("table")).toBeVisible();
});

// ---- Rule: An app result reaches the conversation only by the owner's tap (SEC-5) ---------------------------------

/** The Tier-2 test app of "devtool" that offers a button. Its script puts `ready` on the page when the frame has started. */
const bookingHtml = frameHtml(
  `<p id="s">starting</p><button id="b">Book it</button>`,
  `convoz.onInit(function () { document.getElementById("s").textContent = "Booking ready"; document.getElementById("b").onclick = function () { convoz.result({ summary: "Book Thursday 10:00", value: { slot: "Thursday 10:00" } }); }; });`,
);

scenario("The owner confirms an app result on a sheet drawn by the host", { tag: ["@browser"] }, async ({ server, page, context, dataDir }) => {
  // Background
  const a = await appsWorld({ server, page, context, browser: true });

  // Given a Tier-2 booking app from "devtool" offers "Book it" for "Thursday 10:00"
  await postFrame(a, bookingHtml, { title: "Booking" });
  await openConversation(page, a.w.srv, a.conv);
  await openApp(page, "Booking", "Booking ready");

  // When the owner taps "Book it" inside the app
  await appFrame(page, "Booking").getByRole("button", { name: "Book it" }).click();

  // Then a host sheet outside the frame shows the message it will send
  const sheet = resultSheet(page);
  await expect(sheet).toContainText("Book Thursday 10:00");
  await expect(sheet).toContainText("via app by @devtool");
  await expect(sheet).toHaveCount(1); // a page locator does not look into the frame: the sheet is the host's own
  expect(viaAppRows(dataDir)).toEqual([]);

  // And only the owner's tap on that sheet posts it, marked "via app by @devtool"
  await sheet.getByRole("button", { name: "Send" }).click();
  await expect.poll(() => viaAppRows(dataDir).length).toBe(1);
  const sent = (await pageOf(a)).find((m) => m.via_app);
  expect(sent).toMatchObject({ body: "Book Thursday 10:00", author: { handle: "drew" }, via_app: { agent: { handle: "devtool" } } });
  await expect(page.getByText("via app by @devtool")).toBeVisible();
});

scenario("An app result does not count as the owner speaking", { tag: ["@browser"] }, async ({ server, page, context }) => {
  // Background
  const a = await appsWorld({ server, page, context, browser: true });

  // Given conversation 41 is paused after 20 agent messages
  const picker = await postApp(a, validApp("picker-single-prototype-a2"), "Which runner?");
  for (let i = 1; i < 20; i++) must(await agentPost(a.w.srv, i % 2 ? a.docs.lease : a.devtool.lease, a.conv, `Agent message ${i}`), `agent message ${i}`, 201);
  await openConversation(page, a.w.srv, a.conv);
  await expect(page.getByRole("button", { name: "Resume" }).first()).toBeVisible();

  // When the owner confirms an app result
  const card = appCard(page, "Runner picker");
  await card.getByRole("button", { name: "Expand app" }).click();
  await card.getByRole("button", { name: "vitest" }).click();
  await expect.poll(async () => (await pageOf(a)).some((m) => m.via_app?.message_id === picker)).toBe(true);

  // Then the conversation stays paused
  await expect(page.getByRole("button", { name: "Resume" }).first()).toBeVisible();
  const view = must(await a.w.owner.client.get(`/api/conversations/${a.conv}`), "read the conversation").json().conversation;
  expect(view.paused).toBe(true);
  expect((await agentPost(a.w.srv, a.devtool.lease, a.conv, "Still stopped")).json().error.code).toBe("conversation_paused");
});

scenario("One tap on a picker answers the agent", { tag: ["@browser", "@cli"] }, async ({ server, page, context }, info) => {
  info.setTimeout(60_000);
  // Background
  const a = await appsWorld({ server, page, context, browser: true });

  // Given "devtool" replied in a thread with a picker "Which runner should I compare first?" offering "Built-in", "vitest" and "jest"
  const rootText = "Step 1 is the runner comparison";
  const root = await ownerSays(a.w.owner, a.conv, rootText);
  const file = write(tmp(), "picker.json", validApp("picker-single-prototype-a2"));
  const replied = await convoz(a.w.box, a.devtool.sid, ["reply", "--app", file, String(root), "Which runner should I compare first?"]);
  expect(replied.code).toBe(0);
  await openConversation(page, a.w.srv, a.conv);
  await openThread(page, rootText);

  // When the owner taps "vitest"
  const card = appCard(page, "Runner picker");
  await card.getByRole("button", { name: "Expand app" }).click();
  await card.getByRole("button", { name: "vitest" }).click();

  // Then the thread shows "Picked vitest" marked "via app by @devtool"
  const log = threadLog(page);
  await expect(log.getByText("Picked vitest")).toBeVisible();
  await expect(log.getByText("via app by @devtool")).toBeVisible();
  expect((await thread(a, root)).map((m) => m.body)).toContain("Picked vitest");

  // And "devtool" gets one "app_result" item whose result selected "vitest"
  const items = (await inboxItems(a.w.box, a.devtool.sid, ["--peek"])) as any[];
  const results = items.filter((i) => i.reason === "app_result");
  expect(results).toHaveLength(1);
  expect(results[0].message.via_app.result.value).toEqual({ selected: ["vitest"] });
});

scenario("A form result is checked on a host sheet before it is sent", { tag: ["@browser"] }, async ({ server, page, context, dataDir }) => {
  // Background
  const a = await appsWorld({ server, page, context, browser: true });

  // Given "devtool" posted a form "Schedule the run" with a start time and lanes
  const form = validApp("form");
  form.title = "Schedule the run";
  form.props.submitLabel = "Submit";
  form.props.fields = form.props.fields.filter((f: { id: string }) => ["start", "lanes"].includes(f.id));
  await postApp(a, form, "Schedule the run");
  await openConversation(page, a.w.srv, a.conv);

  // When the owner fills it and taps Submit
  const card = appCard(page, "Schedule the run");
  await card.getByRole("button", { name: "Expand app" }).click();
  await card.getByLabel("Start (UTC hour)").fill("3");
  await card.getByLabel("Lanes").selectOption({ label: "All lanes" });
  await card.getByRole("button", { name: "Submit" }).click();

  // Then a host sheet shows every value with Send and Cancel
  const sheet = resultSheet(page);
  await expect(sheet).toContainText("3");
  await expect(sheet).toContainText(/all lanes|all/i);
  await expect(sheet.getByRole("button", { name: "Send" })).toBeVisible();
  await expect(sheet.getByRole("button", { name: "Cancel" })).toBeVisible();

  // And Cancel sends nothing
  await sheet.getByRole("button", { name: "Cancel" }).click();
  await expect(sheet).toHaveCount(0);
  await page.waitForTimeout(500);
  expect(viaAppRows(dataDir)).toEqual([]);
});

scenario("An app that tries to leave is closed", { tag: ["@browser"] }, async ({ server, page, context, dataDir }) => {
  // Background
  const a = await appsWorld({ server, page, context, browser: true });
  const requests = requestLog(page);

  // Given an open Tier-2 app from "devtool" whose script sends its page to an outside address
  await postFrame(
    a,
    frameHtml(`<p id="s">starting</p>`, `convoz.onInit(function () { document.getElementById("s").textContent = "leaving now"; setTimeout(function () { location.href = "https://example.com/out"; }, 150); });`),
    { title: "Leaver" },
  );
  await openConversation(page, a.w.srv, a.conv);

  // When the app navigates away
  await appCard(page, "Leaver").getByRole("button", { name: /^Open app/ }).click();

  // Then the app is closed with "This app tried to leave and was closed"
  await expect(appCard(page, "Leaver")).toContainText("This app tried to leave and was closed");
  await expect(appCard(page, "Leaver")).toHaveAttribute("data-app-state", "closed");

  // And nothing was sent as the owner
  expect(viaAppRows(dataDir)).toEqual([]);
  expect((await pageOf(a)).filter((m) => m.author.handle === "drew")).toEqual([]);
  expect(requests.filter((u) => u.includes("example.com"))).toEqual([]);
});

scenario("A chart on an ask helps the owner decide but never answers", { tag: ["@browser"] }, async ({ server, page, context }) => {
  // Background
  const a = await appsWorld({ server, page, context, browser: true });

  // Given "devtool" asked "Which lane first?" with a chart of the lanes
  const asked = await postAsk(a.w.srv, a.devtool.lease, { ...askBody(a.conv, { question: "Which lane first?" }), app: validApp("chart-bar-prototype-a1") });
  const askId = Number(must(asked, "ask with a chart", 201).json().ask.id);
  await openConversation(page, a.w.srv, a.conv);

  // When the owner clicks a bar of the chart
  const ask = page.getByRole("article", { name: "Which lane first?" });
  const chart = appCard(page, "Tokens per day");
  await chart.getByRole("button", { name: "Expand app" }).click();
  await chart.locator("[data-bar]").first().click();

  // Then the ask is still open
  expect((await askOf(a.w.owner, askId)).state).toBe("open");
  await expect(ask.getByRole("button", { name: "Merge it" })).toBeVisible();

  // And only the ask's own buttons answer it
  await ask.getByRole("button", { name: "Merge it" }).click();
  await expect.poll(async () => (await askOf(a.w.owner, askId)).state).toBe("answered");
});

// ---- Rule: App previews respect a slow link ------------------------------------------------------------------------

scenario("App previews wait for a tap on a slow network", { tag: ["@browser", "@lossy"] }, async ({ server, page, context }, info) => {
  info.setTimeout(60_000);
  // Given the browser reports Save-Data on
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "connection", { value: { saveData: true, effectiveType: "4g", addEventListener() {}, removeEventListener() {} }, configurable: true });
  });
  const a = await appsWorld({ server, page, context, browser: true });
  const first = await stored(a.w.srv, a.devtool.lease, png(200, 40, 40), "image");
  const second = await stored(a.w.srv, a.devtool.lease, png(40, 200, 40), "image");
  const gallery = validApp("gallery-compare");
  gallery.props.images[0].upload = first.upload;
  gallery.props.images[1].upload = second.upload;
  await postApp(a, gallery, "The gallery");
  const big = validApp("chart-bar-prototype-a1");
  big.title = "Big chart";
  const labels = Array.from({ length: 400 }, (_, i) => `d${i}`);
  big.props.x.labels = labels;
  big.props.series = [{ name: "Lane", values: labels.map((_l, i) => 1000 + i * 3 + 0.5), tone: "accent" }, { name: "Other", values: labels.map((_l, i) => 900 + i * 2 + 0.5), tone: "muted" }];
  big.props.refLines = [];
  await postApp(a, big, "The big chart");
  await postFrame(a, padded(frameHtml(`<p id="s">starting</p>`, `convoz.onInit(function () { document.getElementById("s").textContent = "loaded"; });`), 61440), { title: "Deploy report", body: "The report" });
  const requests = requestLog(page);

  // When the owner opens a conversation with a gallery, a chart with large data and a Tier-2 app
  await openConversation(page, a.w.srv, a.conv);

  // Then each shows a placeholder with its size and "tap to load"
  await expect(appCard(page, "Search bar, before and after")).toContainText(/tap to load · \d+(\.\d+)? ?(KB|B|MB)/i);
  await expect(appCard(page, "Big chart")).toContainText(/tap to load · \d+(\.\d+)? ?(KB|B|MB)/i);
  await expect(appCard(page, "Deploy report")).toContainText(/61 KB · tap to load/i);

  // And nothing of them loads until the owner taps it
  await page.waitForTimeout(500);
  expect(requests.filter((u) => /\/api\/files\/|\/api\/messages\/\d+\/app|\/api\/apps\/\d+\/frame/.test(u))).toEqual([]);
  await appCard(page, "Search bar, before and after").getByRole("button", { name: /tap to load/i }).click();
  await expect.poll(() => requests.some((u) => u.includes("/api/files/"))).toBe(true);
});

scenario("A Tier-2 app opens only when the owner taps it, on any network", { tag: ["@browser"] }, async ({ server, page, context }) => {
  // Background
  const a = await appsWorld({ server, page, context, browser: true });

  // Given "devtool" posted the Tier-2 app "Deploy report" of 61 KB that can send a reply
  await postFrame(a, padded(frameHtml(`<p id="s">starting</p>`, `convoz.onInit(function () { document.getElementById("s").textContent = "Report loaded"; });`), 61440), { title: "Deploy report", body: "The report", results: true });
  const requests = requestLog(page);

  // When the owner opens conversation 41 on a fast network
  await openConversation(page, a.w.srv, a.conv);

  // Then a preview card shows "Deploy report", "App from @devtool", "61 KB" and "This app can send a reply for you"
  const card = appCard(page, "Deploy report");
  await expect(card).toHaveAttribute("data-app-state", "preview");
  for (const text of ["Deploy report", "App from @devtool", "61 KB", "This app can send a reply for you"]) await expect(card).toContainText(text);
  await page.waitForTimeout(500);
  expect(requests.filter((u) => /\/api\/apps\/\d+\/frame/.test(u))).toEqual([]);

  // And the app loads only after the owner taps "Open app"
  await card.getByRole("button", { name: "Open app" }).click();
  await expect(appFrame(page, "Deploy report").getByText("Report loaded")).toBeVisible();
  expect(requests.filter((u) => /\/api\/apps\/\d+\/frame/.test(u))).toHaveLength(1);
});

scenario("An app this version cannot show falls back to its text", { tag: ["@browser"] }, async ({ server, page, context, dataDir }) => {
  // Background
  const a = await appsWorld({ server, page, context, browser: true });
  const devtool = identityId(dataDir, "devtool");

  // Given messages with an app of a newer version, an app of an unknown type and a frame that needs bridge 2
  const frame = frameApp({ upload: "AAAAAAAAAAAAAAAAAAAAAA", sha256: "0".repeat(64), size: 10 }, { title: "Bridge two", fallback: "Bridge two app text" });
  frame.props.manifest.bridge = 2;
  const unsupported = [
    { v: 2, type: "kv", fallback: "Newer app text", props: { pairs: [] } },
    { v: 1, type: "map", fallback: "Map app text", props: {} },
    frame,
  ];
  const db = plainDb(dataDir);
  for (const [i, app] of unsupported.entries()) {
    db.prepare("INSERT INTO messages (conversation_id, author_id, kind, format, body, app_json, created_at) VALUES (?, ?, 'text', 'plain', ?, ?, ?)").run(a.conv, devtool, `Unsupported ${i}`, JSON.stringify(app), Date.now() + i);
  }
  db.close();
  const errors = consoleErrors(page);

  // When an older build of the web app shows the conversation
  await openConversation(page, a.w.srv, a.conv);

  // Then each shows its fallback text with "Update Convoz to view this app"
  const cards = page.locator('section[data-app][data-app-state="fallback"]');
  await expect(cards).toHaveCount(3);
  for (const text of ["Newer app text", "Map app text", "Bridge two app text"]) {
    const card = cards.filter({ hasText: text });
    await expect(card).toContainText("Update Convoz to view this app");
  }

  // And the browser console shows no error
  expect(errors).toEqual([]);
});

// ---- Contracts: the validators agree ---------------------------------------------------------------------------

/** The validator the web app ships (packages/app-kit/src/validate.ts), built as one script the page can run. */
async function webValidatorScript(): Promise<string> {
  const need = createRequire(path.join(repoRoot, "packages", "app-kit", "package.json"));
  const vite = await import(pathToFileURL(need.resolve("vite")).href);
  const built = await vite.build({
    configFile: false,
    logLevel: "silent",
    root: repoRoot,
    build: { write: false, minify: false, lib: { entry: path.join(repoRoot, "packages", "app-kit", "src", "validate.ts"), formats: ["iife"], name: "ConvozValidate" } },
  });
  const out = Array.isArray(built) ? built[0] : built;
  return out.output[0].code as string;
}

scenario("Server, CLI and web app agree on every app fixture", { tag: ["@api", "@cli", "@browser"] }, async ({ server, page, context }, info) => {
  info.setTimeout(120_000);
  // Background
  const a = await appsWorld({ server, page, context, browser: true });

  // Given the app fixtures in schemas/examples, valid and invalid
  const fixtures = [...examples("valid").map((e) => ({ ...e, valid: true })), ...examples("invalid").map((e) => ({ ...e, valid: false }))].filter((e) => e.schema === "app.json");
  expect(fixtures.filter((f) => f.valid).length).toBeGreaterThan(8);
  expect(fixtures.filter((f) => !f.valid).length).toBeGreaterThan(25);
  const dir = tmp();

  // When each is checked by POST /api/apps/validate, "convoz app validate" and the web app validator
  const bySchema: Record<string, { ok: boolean; code?: string; path?: string }> = {};
  const byApi: typeof bySchema = {};
  const byCli: typeof bySchema = {};
  for (const f of fixtures) {
    const res = await send(a.w.srv.target, "POST", "/api/apps/validate", { json: f.data, headers: bearer(a.devtool.lease).headers });
    byApi[f.name] = res.status === 200 ? { ok: true } : { ok: false, code: res.json().error.code, path: res.json().error.path };
    const file = write(dir, `${f.name}.json`, f.data);
    const ran = await convoz(a.w.box, a.devtool.sid, ["app", "validate", "--json", file]);
    const out = JSON.parse(ran.stdout);
    byCli[f.name] = ran.code === 0 ? { ok: true } : { ok: false, code: out.code, path: out.path };
  }
  await page.goto(`${a.w.srv.origin}/`);
  await page.evaluate(await webValidatorScript()); // a string runs through the debugger, which the page CSP (no inline script) does not govern
  const byWeb = (await page.evaluate((list) => {
    const v = (window as any).ConvozValidate;
    return Object.fromEntries(list.map((f: any) => [f.name, v.validateApp(f.data)]));
  }, fixtures.map((f) => ({ name: f.name, data: f.data })))) as Record<string, { ok: boolean; code?: string; path?: string }>;
  for (const f of fixtures) bySchema[f.name] = f.valid ? { ok: true } : { ok: false, code: f.expect!.code, path: f.expect!.path };

  // Then all three accept every valid fixture
  const verdict = (v: { ok: boolean; code?: string; path?: string }) => (v.ok ? { ok: true } : { ok: false, code: v.code, path: v.path });
  for (const f of fixtures.filter((x) => x.valid)) {
    expect({ name: f.name, api: verdict(byApi[f.name]!), cli: verdict(byCli[f.name]!), web: verdict(byWeb[f.name]!) }).toEqual({ name: f.name, api: { ok: true }, cli: { ok: true }, web: { ok: true } });
  }

  // And all three reject every invalid fixture with its expected code and path
  for (const f of fixtures.filter((x) => !x.valid)) {
    const want = bySchema[f.name];
    expect({ name: f.name, api: verdict(byApi[f.name]!), cli: verdict(byCli[f.name]!), web: verdict(byWeb[f.name]!) }).toEqual({ name: f.name, api: want, cli: want, web: want });
  }
});

// ---- Contracts: Tier-2 apps run sandboxed and cannot reach anything --------------------------------------------

scenario("A Tier-2 app cannot reach the network", { tag: ["@browser"] }, async ({ server, page, context }) => {
  // Background
  const a = await appsWorld({ server, page, context, browser: true });

  // Given "devtool" posted a Tier-2 app whose script calls fetch("https://example.com")
  await postFrame(
    a,
    frameHtml(`<p id="s">starting</p>`, `convoz.onInit(function () { fetch("https://example.com/").catch(function () {}); document.getElementById("s").textContent = "rendered"; });`),
    { title: "Fetcher" },
  );
  const requests = requestLog(page);
  await openConversation(page, a.w.srv, a.conv);

  // When the owner opens it
  await appCard(page, "Fetcher").getByRole("button", { name: /^Open app/ }).click();

  // Then it renders
  await expect(appFrame(page, "Fetcher").getByText("rendered")).toBeVisible();

  // And the browser network log has no request to "example.com"
  await page.waitForTimeout(500);
  expect(requests.filter((u) => u.includes("example.com"))).toEqual([]);
});

scenario("A Tier-2 frame runs with scripts only", { tag: ["@browser"] }, async ({ server, page, context }) => {
  // Background
  const a = await appsWorld({ server, page, context, browser: true });

  // Given "devtool" posted a Tier-2 app
  await postFrame(
    a,
    frameHtml(
      `<p id="parent">starting</p><p id="cookie">starting</p>`,
      `convoz.onInit(function () {
        try { void parent.document.title; document.getElementById("parent").textContent = "parent: read"; } catch (e) { document.getElementById("parent").textContent = "parent: blocked"; }
        try { void document.cookie; document.getElementById("cookie").textContent = "cookie: read"; } catch (e) { document.getElementById("cookie").textContent = "cookie: blocked"; }
      });`,
    ),
    { title: "Sandboxed" },
  );
  await openConversation(page, a.w.srv, a.conv);

  // When the owner opens it
  await openApp(page, "Sandboxed", "blocked");

  // Then its frame has sandbox "allow-scripts" and an empty allow list
  const iframe = page.locator('iframe[title="Sandboxed (sandboxed)"]');
  expect(await iframe.getAttribute("sandbox")).toBe("allow-scripts");
  expect(await iframe.getAttribute("allow")).toBe("");

  // And the frame cannot read the parent page or its cookies
  await expect(appFrame(page, "Sandboxed").locator("#parent")).toHaveText("parent: blocked");
  await expect(appFrame(page, "Sandboxed").locator("#cookie")).toHaveText("cookie: blocked");
});

scenario("A message from another frame's port is ignored", { tag: ["@browser"] }, async ({ server, page, context, dataDir }) => {
  // Background
  const a = await appsWorld({ server, page, context, browser: true });

  // Given two Tier-2 apps are open in conversation 41
  const claim = `{ t: "result", v: 1, id: "nonce-0001", summary: "From the second app", value: { app: 2 } }`;
  await postFrame(
    a,
    frameHtml(
      `<p id="s">starting</p>`,
      `convoz.onInit(function () {
        document.getElementById("s").textContent = "first ready";
        setTimeout(function () {
          parent.postMessage(${claim}, "*");
          for (var i = 0; i < parent.frames.length; i++) parent.frames[i].postMessage(${claim}, "*");
        }, 300);
      });`,
    ),
    { title: "First" },
  );
  await postFrame(a, frameHtml(`<p id="s">starting</p>`, `convoz.onInit(function () { document.getElementById("s").textContent = "second ready"; });`), { title: "Second" });
  await openConversation(page, a.w.srv, a.conv);
  await openApp(page, "Second", "second ready");
  await openApp(page, "First", "first ready");

  // When the first app posts a message that claims to come from the second
  await page.waitForTimeout(1200);

  // Then the host ignores it and shows no confirm sheet
  await expect(resultSheet(page)).toHaveCount(0);
  expect(viaAppRows(dataDir)).toEqual([]);
});

scenario("A hostile frame sends nothing and reaches nothing", { tag: ["@browser"] }, async ({ server, page, context, dataDir }, info) => {
  info.setTimeout(120_000);
  // Background
  const a = await appsWorld({ server, page, context, browser: true });
  const requests = requestLog(page);
  const rows: [string, string][] = [
    ["calls window.parent.postMessage with a result", `parent.postMessage({ t: "result", v: 1, id: "nonce-0001", summary: "hack", value: 1 }, "*");`],
    ["posts a result on its port without a tap", `convoz.result({ summary: "No tap", value: 1 });`],
    ["calls fetch to an outside address", `fetch("https://example.com/steal").catch(function () {});`],
    ["writes to localStorage", `try { localStorage.setItem("k", "v"); } catch (e) {}`],
    ["sets its location to an outside address", `location.href = "https://example.com/out";`],
  ];
  for (const [i, [does, code]] of rows.entries()) {
    // Given a Tier-2 test app whose script <does>
    const title = `Hostile ${i + 1}`;
    await postFrame(a, frameHtml(`<p id="s">starting</p>`, `convoz.onInit(function () { document.getElementById("s").textContent = "ran ${i + 1}"; setTimeout(function () { ${code} }, 100); });`), { title });
    await openConversation(page, a.w.srv, a.conv);

    // When the owner opens it and taps nothing
    await openApp(page, title, `ran ${i + 1}`);
    await page.waitForTimeout(700);

    // Then no message is sent
    expect({ does, sent: viaAppRows(dataDir).length, owner: (await pageOf(a)).filter((m) => m.author.handle === "drew").length }).toEqual({ does, sent: 0, owner: 0 });

    // And the browser request log has no request outside the server's origin
    expect({ does, outside: requests.filter((u) => !u.startsWith(a.w.srv.origin) && !/^(data|blob|about):/.test(u)) }).toEqual({ does, outside: [] });
  }
});

// Skipped: the scenario is @unimplemented in apps-host.feature. Its step says the frame loads from the service worker cache, but a
// sandboxed frame has an opaque origin and no worker, so the browser's own cache (immutable by hash) keeps the document instead.
test.skip("A frame document is cached by its hash", { tag: ["@browser"] }, async ({ server, page, context }, info) => {
  info.setTimeout(60_000);
  // Background
  const a = await appsWorld({ server, page, context, browser: true });

  // Given the owner opened a Tier-2 app once
  await postFrame(a, frameHtml(`<p id="s">starting</p>`, `convoz.onInit(function () { document.getElementById("s").textContent = "cached frame"; });`), { title: "Cached" });
  await openConversation(page, a.w.srv, a.conv);
  await openApp(page, "Cached", "cached frame");
  await appCard(page, "Cached").getByRole("button", { name: "Close app" }).click();

  // When the browser goes offline and the owner opens it again
  await context.setOffline(true);
  await appCard(page, "Cached").getByRole("button", { name: /^Open app/ }).click();

  // Then the frame loads from the service worker cache
  // (Chromium gives a sandboxed frame with an opaque origin no service worker, so the document is kept by the browser cache: it is immutable by its hash.)
  await expect(appFrame(page, "Cached").getByText("cached frame")).toBeVisible();
  await expect(appCard(page, "Cached")).toHaveAttribute("data-app-state", "open");
});
