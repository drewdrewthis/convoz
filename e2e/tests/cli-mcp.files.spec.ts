import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { machineVia } from "../lib/agent-wp7.ts";
import { chatWorld, convoz, createConversation, ownerSays, startSession } from "../lib/chat.ts";
import { messageLog } from "../lib/chat-ui.ts";
import { cutProxy } from "../lib/cut-proxy.ts";
import { forwarder } from "../lib/left.ts";
import { pageOf } from "../lib/messages-wp4.ts";
import { must } from "../lib/owner.ts";
import { expect, scenario } from "../lib/scenario.ts";
import { openConversation, voiceWorld } from "../lib/ui-wp10.ts";

// Owner (Drew, voice call via @dot, conv 2 msg 185): "support sending ordinary files, especially PDFs and Markdown, through the agent CLI"
// Bindings of the rule "An agent sends ordinary files with a post or a reply" of features/cli-mcp.feature.

const PDF = Buffer.from("%PDF-1.4\n% TESTONLY report\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n");
const NOTES_MD = Buffer.from("# TESTONLY notes\n\n- one\n- two\n");

/** Background: "devtool" is in conversation 41, "docs" is an agent of the same machine that is not. */
async function world(server: Parameters<typeof chatWorld>[0]) {
  const w = await chatWorld(server, { agents: ["devtool", "docs"] });
  const conv = await createConversation(w.owner, { title: "Ship search filters", participants: ["devtool"] });
  const devtool = await startSession(w.box, "devtool", "files-devtool");
  return { w, conv, devtool };
}

/** A folder of fresh files: name -> bytes. Returns name -> path. */
function files(spec: Record<string, Buffer>): Record<string, string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "convoz-send-"));
  return Object.fromEntries(
    Object.entries(spec).map(([name, bytes]) => {
      const p = path.join(dir, name);
      fs.writeFileSync(p, bytes);
      return [name, p];
    }),
  );
}

/** The message of this conversation with this body, from the owner's side. */
async function messagesWith(w: Awaited<ReturnType<typeof world>>["w"], conv: number, body: string) {
  return (await pageOf(w.owner, conv, "limit=100")).filter((m) => m.body === body);
}

scenario("An agent posts a PDF and a Markdown file", { tag: ["@cli"] }, async ({ server }) => {
  // Background
  const { w, conv, devtool } = await world(server);
  const f = files({ "report.pdf": PDF, "notes.md": NOTES_MD });

  // When "devtool" runs "convoz post --file report.pdf --file notes.md 41 'Report and notes'"
  const res = await convoz(w.box, devtool.sid, ["post", "--file", f["report.pdf"]!, "--file", f["notes.md"]!, String(conv), "Report and notes"]);

  // Then the CLI prints one line holding the message id and exits 0
  expect(res.code, res.stderr).toBe(0);
  expect(res.stdout).toMatch(/^\d+\n$/);

  // And conversation 41 shows one message "Report and notes" that carries "report.pdf" and "notes.md"
  const posted = await messagesWith(w, conv, "Report and notes");
  expect(posted).toHaveLength(1);
  expect(posted[0]!.uploads!.map((u) => [u.name, u.size])).toEqual([
    ["report.pdf", PDF.length],
    ["notes.md", NOTES_MD.length],
  ]);

  // And the text may be left out: "convoz post --json --file notes.md 41" prints the message id and the id, name and size of the file
  const bare = await convoz(w.box, devtool.sid, ["post", "--json", "--file", f["notes.md"]!, String(conv)]);
  expect(bare.code, bare.stderr).toBe(0);
  const out = JSON.parse(bare.stdout) as { id: number; uploads: { id: string; name: string; size: number }[] };
  expect(out.uploads).toEqual([{ id: expect.stringMatching(/^[A-Za-z0-9_-]{22}$/), name: "notes.md", size: NOTES_MD.length }]);
  const alone = (await pageOf(w.owner, conv, "limit=100")).find((m) => m.id === out.id);
  expect(alone?.uploads?.map((u) => u.id)).toEqual([out.uploads[0]!.id]);
});

scenario("The owner sees the files an agent posted", { tag: ["@browser"] }, async ({ server, page, context }) => {
  // Given "devtool" posted "report.pdf" and "notes.md" in conversation 41 with "convoz post --file"
  const u = await voiceWorld({ server, page, context });
  const f = files({ "report.pdf": PDF, "notes.md": NOTES_MD });
  const res = await convoz(u.w.box, u.devtool.sid, ["post", "--file", f["report.pdf"]!, "--file", f["notes.md"]!, String(u.conv), "Report and notes"]);
  expect(res.code, res.stderr).toBe(0);

  // When the owner opens conversation 41
  await openConversation(page, u.w.srv, u.conv);

  // Then the message shows a download card for "report.pdf" and one for "notes.md"
  const message = messageLog(page).getByRole("article").filter({ hasText: "Report and notes" });
  await expect(message.getByRole("link", { name: /report\.pdf/ })).toBeVisible();
  await expect(message.getByRole("link", { name: /notes\.md/ })).toBeVisible();
});

scenario("An agent that is not in the conversation cannot attach files", { tag: ["@cli"] }, async ({ server }) => {
  // Given "docs" is an agent on "box-2" that is not in conversation 41
  const { w, conv } = await world(server);
  const docs = await startSession(w.box, "docs", "files-docs");
  const proxy = await forwarder(w.srv.target);
  try {
    const via = await machineVia(proxy.url, w.box2.key, w.box, docs.sid);
    const f = files({ "report.pdf": PDF });

    // When "docs" runs "convoz post --file report.pdf 41 'Report'"
    const res = await convoz(via, docs.sid, ["post", "--file", f["report.pdf"]!, String(conv), "Report"]);

    // Then the CLI exits 3 and the error names "report.pdf"
    expect(res.code, res.stderr).toBe(3);
    expect(res.stderr).toContain("report.pdf");

    // And no file is sent and conversation 41 holds no message from "docs"
    expect(proxy.log.filter((e) => e.method === "PATCH")).toHaveLength(0);
    expect(proxy.entries("POST", "/api/uploads").map((e) => e.status)).toEqual([403]);
    expect(await messagesWith(w, conv, "Report")).toHaveLength(0);
    expect((await pageOf(w.owner, conv, "limit=100")).filter((m) => m.uploads?.length)).toHaveLength(0);
  } finally {
    await proxy.close();
  }
});

scenario("A message with 11 files is refused before anything is sent", { tag: ["@cli"] }, async ({ server }) => {
  const { w, conv, devtool } = await world(server);
  const proxy = await forwarder(w.srv.target);
  try {
    const via = await machineVia(proxy.url, w.box2.key, w.box, devtool.sid);
    const many = files(Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`f${i}.md`, NOTES_MD])));

    // When "devtool" runs "convoz post" with 11 "--file" flags for 41
    const res = await convoz(via, devtool.sid, ["post", ...Object.values(many).flatMap((p) => ["--file", p]), String(conv), "Too many"]);

    // Then the CLI exits 2 and says a message carries at most 10 files
    expect(res.code, res.stderr).toBe(2);
    expect(res.stderr).toContain("at most 10 files");

    // And Convoz received no request from that command
    expect(proxy.log).toHaveLength(0);
    expect(await messagesWith(w, conv, "Too many")).toHaveLength(0);
  } finally {
    await proxy.close();
  }
});

scenario("A reply with a file lands in the thread", { tag: ["@cli"] }, async ({ server }) => {
  // Given the owner wrote a message in conversation 41
  const { w, conv, devtool } = await world(server);
  const root = await ownerSays(w.owner, conv, "@devtool please send the report");
  const f = files({ "report.pdf": PDF });

  // When "devtool" runs "convoz reply --file report.pdf <message>" with no text
  const res = await convoz(w.box, devtool.sid, ["reply", "--json", "--file", f["report.pdf"]!, String(root)]);
  expect(res.code, res.stderr).toBe(0);
  const reply = JSON.parse(res.stdout) as { id: number; uploads: { name: string }[] };

  // Then the reply is in the thread of that message and carries "report.pdf"
  const thread = must(await w.owner.client.get(`/api/messages/${root}/replies`), "thread").json() as { messages: { id: number; uploads?: { name: string }[] }[] };
  expect(thread.messages.filter((m) => m.id === reply.id).map((m) => m.uploads?.map((x) => x.name))).toEqual([["report.pdf"]]);

  // And the main list of conversation 41 does not show the reply
  expect((await pageOf(w.owner, conv, "limit=100")).map((m) => m.id)).not.toContain(reply.id);
});

scenario("A dropped connection mid-upload resumes and posts once", { tag: ["@cli", "@lossy"] }, async ({ server }, info) => {
  info.setTimeout(90_000);
  const { w, conv, devtool } = await world(server);
  const big = Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(3 * 1024 * 1024, "TESTONLY ")]);
  const f = files({ "big.pdf": big });

  // Given a fault proxy cuts the connection in the middle of the first upload of a 3 MB file
  const proxy = await cutProxy(w.srv.target, Math.floor(2.5 * 1024 * 1024));
  try {
    const via = await machineVia(proxy.url, w.box2.key, w.box, devtool.sid);

    // When "devtool" runs "convoz post --file big.pdf 41 'Big report'"
    const res = await via.run(["post", "--sid", devtool.sid, "--timeout", "20s", "--file", f["big.pdf"]!, String(conv), "Big report"], { timeoutMs: 60_000 });

    // Then the proxy log shows the upload continued from where Convoz stopped, not from the start
    const patches = proxy.log.filter((e) => e.method === "PATCH");
    expect(patches[0]).toMatchObject({ cut: true, offset: "0" });
    expect(Number(patches[1]!.offset)).toBeGreaterThanOrEqual(1024 * 1024);
    expect(proxy.log.filter((e) => e.method === "POST" && e.path === "/api/uploads")).toHaveLength(1);

    // And the CLI exits 0
    expect(res.code, res.stderr).toBe(0);

    // And conversation 41 shows "Big report" once with "big.pdf" whole
    const posted = await messagesWith(w, conv, "Big report");
    expect(posted).toHaveLength(1);
    expect(posted[0]!.uploads!.map((u) => [u.name, u.size])).toEqual([["big.pdf", big.length]]);
  } finally {
    await proxy.close();
  }
});

scenario("A post that failed after its files were sent is run again without a second message", { tag: ["@cli", "@lossy"] }, async ({ server }) => {
  const { w, conv, devtool } = await world(server);
  const f = files({ "report.pdf": PDF });
  const route = `/api/conversations/${conv}/messages`;

  // Given the first post of "convoz post --file report.pdf 41 'Report'" is refused after the file was uploaded
  const proxy = await forwarder(w.srv.target, { method: "POST", path: route, status: 400, times: 1 });
  try {
    const via = await machineVia(proxy.url, w.box2.key, w.box, devtool.sid);
    const argv = ["post", "--file", f["report.pdf"]!, String(conv), "Report"];
    const first = await convoz(via, devtool.sid, argv);
    expect(first.code, first.stderr).not.toBe(0);
    expect(await messagesWith(w, conv, "Report")).toHaveLength(0);

    // When "devtool" runs the same command again
    const second = await convoz(via, devtool.sid, argv);

    // Then the CLI exits 0
    expect(second.code, second.stderr).toBe(0);

    // And the file is not uploaded a second time
    expect(proxy.entries("POST", "/api/uploads")).toHaveLength(1);

    // And conversation 41 shows "Report" once with "report.pdf"
    const posted = await messagesWith(w, conv, "Report");
    expect(posted).toHaveLength(1);
    expect(posted[0]!.uploads!.map((u) => u.name)).toEqual(["report.pdf"]);
  } finally {
    await proxy.close();
  }
});
