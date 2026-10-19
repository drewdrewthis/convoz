import { agentPost, chatWorld, convoz, createConversation, messagesOf, ownerPost, ownerSays, startSession } from "../lib/chat.ts";
import { answerAsk, agentAsks } from "../lib/asks.ts";
import { McpClient } from "../lib/agent-wp7.ts";
import { send } from "../lib/http.ts";
import { bearer, clientId } from "../lib/machines.ts";
import { leaseOf, msgWorld, type MsgWorld } from "../lib/messages-wp4.ts";
import { must } from "../lib/owner.ts";
import { expect, scenario } from "../lib/scenario.ts";

/*
 * NEEDS-YOU: specs/contracts/needs-you.feature and the "A post says whether it needs the owner" rule of specs/features/cli-mcp.feature.
 * Owner said (msg 366): "Maybe the message schema should require a true/false field that says if it requires an action/decision from the user -- this will differentiate regular messages from actual blocking requests. We can probably do a lot of powerful stuff with the schema and validation"
 * This release the field is optional: absent counts as false and the answer carries a Convoz-Warning header. true on a plain post is a 422 that
 * names the `convoz ask` command. `needs_you` on a message is computed: true only for an ask that is open.
 */

const WARNING = "needs_you will be required; send needs_you:false for news, or use an ask";

/** A post as an agent with exactly these fields: `needs_you` is not added. */
const rawPost = (w: MsgWorld, lease: string, fields: Record<string, unknown>) =>
  send(w.srv.target, "POST", `/api/conversations/${w.conv}/messages`, { json: { client_id: clientId(), ...fields }, ...bearer(lease) });

const world = async (server: Parameters<typeof msgWorld>[0]["server"], dataDir: string) => {
  const w = await msgWorld({ server, dataDir, agents: ["dot"], participants: ["dot"] });
  return { w, lease: await leaseOf(w, "dot") };
};

const rowOf = async (w: MsgWorld, body: string) => ((await messagesOf(w.owner, w.conv)) as any[]).find((m) => m.body === body);

// ---- contracts ------------------------------------------------------------------------------------------

scenario("needs_you false is accepted as news", { tag: ["@api"] }, async ({ server, dataDir }) => {
  const { w, lease } = await world(server, dataDir);

  // When "dot" posts "Build is green" with needs_you false
  const res = await rawPost(w, lease, { body: "Build is green", needs_you: false });

  // Then the server answers 201
  expect(res.status).toBe(201);
  // And the answer has no Convoz-Warning header
  expect(res.headers["convoz-warning"]).toBeUndefined();
  // And the stored message reads needs_you false
  expect((await rowOf(w, "Build is green")).needs_you).toBe(false);
});

scenario("An absent needs_you is accepted with a warning header", { tag: ["@api"] }, async ({ server, dataDir }) => {
  const { w, lease } = await world(server, dataDir);

  // When "dot" posts "Build is green" without needs_you
  const res = await rawPost(w, lease, { body: "Build is green" });

  // Then the server answers 201
  expect(res.status).toBe(201);
  // And the Convoz-Warning header says the field will be required
  expect(res.headers["convoz-warning"]).toBe(WARNING);
  // And the stored message reads needs_you false
  expect((await rowOf(w, "Build is green")).needs_you).toBe(false);
});

scenario("needs_you true on a plain post is refused with the ask command and the text echoed", { tag: ["@api"] }, async ({ server, dataDir }) => {
  const { w, lease } = await world(server, dataDir);

  // When "dot" posts "Ship it?" with needs_you true
  const res = await rawPost(w, lease, { body: "Ship it?", needs_you: true });

  // Then the server answers 422 "needs_you_is_an_ask" naming "needs_you"
  expect({ status: res.status, code: res.json().error.code, field: res.json().error.field }).toEqual({ status: 422, code: "needs_you_is_an_ask", field: "needs_you" });
  // And the message names "convoz ask" with the text "Ship it?" as the question
  expect(res.json().error.message).toContain('convoz ask --question "Ship it?"');
  // And conversation 41 has no message "Ship it?"
  expect(await rowOf(w, "Ship it?")).toBeUndefined();
});

scenario("A reply in a thread follows the same rule", { tag: ["@api"] }, async ({ server, dataDir }) => {
  const { w, lease } = await world(server, dataDir);

  // Given the owner posted "Status?" in conversation 41
  const root = await ownerSays(w.owner, w.conv, "Status?");

  // When "dot" replies in that thread with needs_you true
  const refused = await rawPost(w, lease, { body: "Which one?", thread_root_id: root, needs_you: true });

  // Then the server answers 422 "needs_you_is_an_ask"
  expect({ status: refused.status, code: refused.json().error.code }).toEqual({ status: 422, code: "needs_you_is_an_ask" });
  // And "dot" replies in that thread with needs_you false and the server answers 201
  expect((await rawPost(w, lease, { body: "Green", thread_root_id: root, needs_you: false })).status).toBe(201);
});

scenario("A refused post spends no rate limit", { tag: ["@api"] }, async ({ server, dataDir }) => {
  const { w, lease } = await world(server, dataDir);

  // When "dot" posts "Ship it?" with needs_you true 40 times
  const refusals: number[] = [];
  for (let i = 0; i < 40; i++) refusals.push((await rawPost(w, lease, { body: "Ship it?", needs_you: true })).status);
  // And "dot" posts "Build is green" with needs_you false
  const last = await rawPost(w, lease, { body: "Build is green", needs_you: false });

  // Then every refusal answers 422 and the last post answers 201
  expect(refusals.every((s) => s === 422)).toBe(true);
  expect(last.status).toBe(201);
});

scenario("The owner posts without needs_you and is never warned", { tag: ["@api"] }, async ({ server, dataDir }) => {
  const { w } = await world(server, dataDir);

  // When the owner posts "Looks good" without needs_you
  const res = await ownerPost(w.owner, w.conv, "Looks good");

  // Then the server answers 201
  expect(res.status).toBe(201);
  // And the answer has no Convoz-Warning header
  expect(res.headers["convoz-warning"]).toBeUndefined();
});

scenario("A plain message reads needs_you false", { tag: ["@api"] }, async ({ server, dataDir }) => {
  const { w, lease } = await world(server, dataDir);

  // Given "dot" posted "Build is green" with needs_you false
  must(await agentPost(w.srv, lease, w.conv, "Build is green", { needs_you: false }), "post", 201);

  // When the owner reads conversation 41
  const row = await rowOf(w, "Build is green");

  // Then the message reads needs_you false
  expect(row.needs_you).toBe(false);
});

scenario("An open ask reads needs_you true and an answered ask reads false", { tag: ["@api"] }, async ({ server, dataDir }) => {
  const { w, lease } = await world(server, dataDir);

  // Given "dot" asked a question in conversation 41
  const id = await agentAsks(w.srv, lease, w.conv);
  const askRow = async () => ((await messagesOf(w.owner, w.conv)) as any[]).find((m) => m.id === id);

  // When the owner reads conversation 41
  // Then the ask message reads needs_you true
  expect((await askRow()).needs_you).toBe(true);

  // When the owner answers the ask
  must(await answerAsk(w.owner, id), "answer", 200);
  // And the owner reads conversation 41
  // Then the ask message reads needs_you false
  expect((await askRow()).needs_you).toBe(false);
});

// ---- cli-mcp.feature ------------------------------------------------------------------------------------

const cliWorld = async (server: Parameters<typeof chatWorld>[0], label: string) => {
  const w = await chatWorld(server, { agents: ["devtool"] });
  const conv = await createConversation(w.owner, { title: "Ship search filters", participants: ["devtool"] });
  const s = await startSession(w.box, "devtool", label);
  return { w, conv, s };
};
const fromDevtool = async (w: Awaited<ReturnType<typeof cliWorld>>["w"], conv: number) => ((await messagesOf(w.owner, conv)) as any[]).filter((m) => m.author.handle === "devtool");
const idLine = /^\d+\n$/;

scenario("A post with --fyi says it does not need the owner", { tag: ["@cli"] }, async ({ server }) => {
  const { w, conv, s } = await cliWorld(server, "fyi");

  // When "devtool" runs "convoz post --fyi 41 'Build is green'"
  const res = await convoz(w.box, s.sid, ["post", "--fyi", String(conv), "Build is green"]);

  // Then the CLI prints one line holding the message id and exits 0
  expect({ code: res.code, id: idLine.test(res.stdout) }).toEqual({ code: 0, id: true });
  // And the CLI prints nothing else
  expect(res.stderr).toBe("");
});

scenario("A post without --fyi still goes out with a hint", { tag: ["@cli"] }, async ({ server }) => {
  const { w, conv, s } = await cliWorld(server, "hint");

  // When "devtool" runs "convoz post 41 'Build is green'"
  const res = await convoz(w.box, s.sid, ["post", String(conv), "Build is green"]);

  // Then the CLI prints one line holding the message id and exits 0
  expect({ code: res.code, id: idLine.test(res.stdout) }).toEqual({ code: 0, id: true });
  // And the CLI also says to add --fyi when the message does not need the owner, and to use "convoz ask" when it does
  expect(res.stderr.trim().split("\n")).toHaveLength(1);
  expect(res.stderr).toContain("add --fyi");
  expect(res.stderr).toContain("convoz ask");
});

scenario("A post that says it needs the owner is refused and points to convoz ask", { tag: ["@cli"] }, async ({ server }) => {
  const { w, conv, s } = await cliWorld(server, "needs");

  // When "devtool" runs "convoz post --needs-you 41 'Ship it?'"
  const res = await convoz(w.box, s.sid, ["post", "--needs-you", String(conv), "Ship it?"]);

  // Then the CLI exits 2 and points to "convoz ask"
  expect({ code: res.code, ask: res.stderr.includes("convoz ask") }).toEqual({ code: 2, ask: true });
  // And conversation 41 shows no message from "devtool"
  expect(await fromDevtool(w, conv)).toEqual([]);
});

scenario("A reply and a new conversation take --fyi the same way", { tag: ["@cli"] }, async ({ server }) => {
  const { w, conv, s } = await cliWorld(server, "reply");

  // Given the owner posted "Status?" in conversation 41
  const root = await ownerSays(w.owner, conv, "Status?");

  // When "devtool" runs "convoz reply --fyi" on that message with "Green" and "convoz new --fyi" with a title and a first message
  const reply = await convoz(w.box, s.sid, ["reply", "--fyi", String(root), "Green"]);
  const made = await convoz(w.box, s.sid, ["new", "--fyi", "Plan: filters", "Step 1 is the parser."]);

  // Then both exit 0 and print one line holding an id
  expect([reply.code, idLine.test(reply.stdout), made.code, idLine.test(made.stdout)]).toEqual([0, true, 0, true]);
  expect([reply.stderr, made.stderr]).toEqual(["", ""]);
  // And "convoz reply --needs-you" and "convoz new --needs-you" exit 2 and point to "convoz ask"
  const replyNeeds = await convoz(w.box, s.sid, ["reply", "--needs-you", String(root), "Which?"]);
  const newNeeds = await convoz(w.box, s.sid, ["new", "--needs-you", "Plan: more", "Which?"]);
  expect([replyNeeds.code, replyNeeds.stderr.includes("convoz ask"), newNeeds.code, newNeeds.stderr.includes("convoz ask")]).toEqual([2, true, 2, true]);
});

scenario("The MCP post, reply and new tools need the needs_you field", { tag: ["@mcp"] }, async ({ server }) => {
  const { w, conv } = await cliWorld(server, "mcp");
  const mcp = await McpClient.start(w.box, "devtool", "claude-TESTONLY-needs-you");
  try {
    // When a client lists the tools of "convoz mcp --as devtool"
    const tools = await mcp.listTools();

    // Then "post", "reply" and "new" each list "needs_you" as a required yes or no field
    for (const name of ["post", "reply", "new"]) {
      const schema = tools.find((t) => t.name === name)!.inputSchema;
      expect(schema.required, name).toContain("needs_you");
      expect(schema.properties.needs_you.type, name).toBe("boolean");
      expect(tools.find((t) => t.name === name)!.description.length, name).toBeLessThanOrEqual(240);
    }

    // And a "post" call with needs_you false posts the message
    const ok = await mcp.tool("post", { conversation: conv, text: "Build is green", needs_you: false });
    expect(ok.isError, ok.content[0]?.text).not.toBe(true);
    expect(((await fromDevtool(w, conv)) as any[]).map((m) => m.body)).toEqual(["Build is green"]);

    // And a "post" call with needs_you true is refused with the "convoz ask" pointer
    const refused = await mcp.tool("post", { conversation: conv, text: "Ship it?", needs_you: true });
    expect(refused.isError).toBe(true);
    expect(JSON.stringify(refused)).toContain("convoz ask");
    expect((await fromDevtool(w, conv)).length).toBe(1);
  } finally {
    mcp.end();
    await mcp.exited;
  }
});

scenario("The rules, the skill and the help tell an agent to use --fyi for news and ask for a decision", { tag: ["@cli"] }, async ({ server }) => {
  const { w } = await cliWorld(server, "words");

  // When "devtool" runs "convoz rules", "convoz help" and "convoz post --help"
  const rules = await w.box.run(["rules", "--as", "devtool"]);
  const help = await w.box.run(["--help"]);
  const post = await w.box.run(["post", "--help"]);

  // Then each exits 0 and names "--fyi"
  for (const r of [rules, help, post]) {
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain("--fyi");
  }
  // And the rules and the help name "convoz ask" for a message that needs the owner
  expect(rules.stdout).toContain("convoz ask");
  expect(help.stdout).toContain("convoz ask");
});
