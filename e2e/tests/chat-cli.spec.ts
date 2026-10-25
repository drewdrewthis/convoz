import { spawnSync } from "node:child_process";
import {
  agentPost,
  agentSays,
  chatWorld,
  convoz,
  createConversation,
  exitsWithin,
  inboxItems,
  ownerPost,
  ownerSays,
  peekFor,
  startSession,
  startWatch,
  watchLines,
} from "../lib/chat.ts";
import { machineVia } from "../lib/agent-wp7.ts";
import { must } from "../lib/owner.ts";
import { clientId } from "../lib/machines.ts";
import type { Running } from "../lib/cli.ts";
import { pollCut } from "../lib/poll-cut.ts";
import { expect, scenario } from "../lib/scenario.ts";

// The contract these bindings rely on is the comment block at the top of chat-api.spec.ts.

// ---- inbox.feature ---------------------------------------------------------------------------------------

scenario("An agent's own messages create no item for itself", { tag: ["@cli"] }, async ({ server }) => {
  // Given conversation 41 "Ship search filters" has "devtool" and "docs", and sessions "s1" and "s2" of "devtool" run on "box-2"
  const w = await chatWorld(server, { agents: ["devtool", "docs"] });
  const conv = await createConversation(w.owner, { title: "Ship search filters", participants: ["devtool", "docs"] });
  const s1 = await startSession(w.box, "devtool", "s1");
  const s2 = await startSession(w.box, "devtool", "s2");
  const docs = await startSession(w.box, "docs", "docs");

  // When session "s1" posts "Starting on it" in conversation 41
  const posted = await convoz(w.box, s1.sid, ["post", "--fyi", String(conv), "Starting on it"]);
  expect(posted.code, posted.stderr).toBe(0);

  // Then "convoz inbox --peek --sid s2" shows no item for that message
  expect(await peekFor(w.box, s2.sid, conv)).toEqual([]);

  // And "convoz inbox --peek" as "docs" shows no item for conversation 41
  expect(await peekFor(w.box, docs.sid, conv)).toEqual([]);
});

scenario("An agent's message wakes another agent only on a mention or its thread", { tag: ["@cli"] }, async ({ server }) => {
  // Given conversation 41 has "devtool" and "docs", with a session "s1" of "devtool" and one of "docs"
  const w = await chatWorld(server, { agents: ["devtool", "docs"] });
  const conv = await createConversation(w.owner, { title: "Ship search filters", participants: ["devtool", "docs"] });
  const s1 = await startSession(w.box, "devtool", "s1");
  const docs = await startSession(w.box, "docs", "docs");
  const drain = async () => {
    for (const i of await inboxItems(w.box, docs.sid, ["--claim", "10", "--wait", "0"])) {
      expect((await convoz(w.box, docs.sid, ["ack", `${i.id}:${i.claim_token}`])).code).toBe(0);
    }
  };

  // When session "s1" posts "Status update" in conversation 41
  await agentSays(w.srv, s1.lease, conv, "Status update");
  // Then "convoz inbox --peek" as "docs" shows no item for conversation 41
  expect(await peekFor(w.box, docs.sid, conv), "no mention, no thread").toEqual([]);

  // When session "s1" posts "@docs can you check?" in conversation 41
  await agentSays(w.srv, s1.lease, conv, "@docs can you check?");
  // Then "convoz inbox --peek" as "docs" shows 1 "mention" item for conversation 41
  expect((await peekFor(w.box, docs.sid, conv)).map((i) => [i.reason, i.count])).toEqual([["mention", 1]]);
  await drain();

  // When "docs" starts a thread in conversation 41 and session "s1" replies in it
  const root = await agentSays(w.srv, docs.lease, conv, "Step 1 is the filter chips UI");
  await drain();
  must(await agentPost(w.srv, s1.lease, conv, "sounds right", { thread_root_id: root }), "thread reply", 201);
  // Then "convoz inbox --peek" as "docs" shows an item with reason "thread" for conversation 41
  expect((await peekFor(w.box, docs.sid, conv)).map((i) => i.reason)).toEqual(["thread"]);
  await drain();

  // When the owner posts "next step?" in conversation 41
  await ownerSays(w.owner, conv, "next step?");
  // Then "convoz inbox --peek" as "docs" shows an item for conversation 41
  expect((await peekFor(w.box, docs.sid, conv)).map((i) => i.reason)).toEqual(["activity"]);
});

scenario("An unacked item comes back to another session", { tag: ["@cli"] }, async ({ server, testApi }) => {
  // Given session "s1" claimed a mention item with a 30-second visibility
  const w = await chatWorld(server, { agents: ["devtool"] });
  const conv = await createConversation(w.owner, { title: "Ship search filters", participants: ["devtool"] });
  const s1 = await startSession(w.box, "devtool", "s1");
  const s2 = await startSession(w.box, "devtool", "s2");
  await ownerSays(w.owner, conv, "@devtool status?");
  const [claimed] = await inboxItems(w.box, s1.sid, ["--claim", "1", "--wait", "0", "--visibility", "30s"]);
  expect(claimed?.claim_token).toBeTruthy();

  // When "s1" does not ack and the visibility passes
  await testApi(w.srv).advanceClock(31_000);

  // Then "s2" returns the same item with a new claim token
  const [again] = await inboxItems(w.box, s2.sid, ["--claim", "1", "--wait", "5"]);
  expect(again?.id).toBe(claimed!.id);
  expect(again?.claim_token).not.toBe(claimed!.claim_token);
});

// ---- cli-mcp.feature: the watch stream -------------------------------------------------------------------------

scenario("The owner's reply is one line in the watch stream", { tag: ["@cli"] }, async ({ server }) => {
  // Given "convoz watch --json" runs as "devtool"
  const w = await chatWorld(server, { agents: ["devtool"] });
  const conv = await createConversation(w.owner, { title: "Ship search filters", participants: ["devtool"] });
  const s = await startSession(w.box, "devtool", "watch");
  const watch = startWatch(w.box, s.sid);
  try {
    // When the owner posts "@devtool yes" in conversation 41
    const id = await ownerSays(w.owner, conv, "@devtool yes");

    // Then the stream prints exactly one JSON line for that message within 3 seconds
    const [line] = await watchLines(watch, 1, 3_000);
    expect({ body: line?.body, message_id: line?.message_id, conversation_id: line?.conversation_id, author: line?.author }).toEqual({
      body: "@devtool yes",
      message_id: id,
      conversation_id: conv,
      author: "drew",
    });
  } finally {
    watch.stop();
  }
});

scenario("A double submit gives one watch line", { tag: ["@cli"] }, async ({ server }) => {
  // Given "convoz watch --json" runs as "devtool"
  const w = await chatWorld(server, { agents: ["devtool"] });
  const conv = await createConversation(w.owner, { title: "Ship search filters", participants: ["devtool"] });
  const s = await startSession(w.box, "devtool", "watch");
  const watch = startWatch(w.box, s.sid);
  try {
    // When the owner's client sends "@devtool yes" twice with the same client id
    await ownerPost(w.owner, conv, "@devtool yes", { clientId: "c-double-aaaa" });
    await ownerPost(w.owner, conv, "@devtool yes", { clientId: "c-double-aaaa" });
    await watchLines(watch, 1, 3_000);

    // Then the stream prints one line for it (a later message is the next line, so no copy came between)
    await ownerSays(w.owner, conv, "after");
    const lines = await watchLines(watch, 2, 5_000);
    expect(lines.map((l) => [l.body, l.count])).toEqual([
      ["@devtool yes", 1],
      ["after", 1],
    ]);
  } finally {
    watch.stop();
  }
});

scenario("A watch line says which thread a message is in and what it answers", { tag: ["@cli"] }, async ({ server }) => {
  // Given "convoz watch --json" runs as "devtool"
  const w = await chatWorld(server, { agents: ["devtool"] });
  const conv = await createConversation(w.owner, { title: "Ship search filters", participants: ["devtool"] });
  const s = await startSession(w.box, "devtool", "watch");
  const watch = startWatch(w.box, s.sid);
  try {
    // And the owner started a thread under "Can step 1 ship on its own?"
    const root = await ownerSays(w.owner, conv, "Can step 1 ship on its own?");
    const reply = (body: string) => w.owner.client.post(`/api/conversations/${conv}/messages`, { client_id: clientId(), body, thread_root_id: root });

    // When the owner replies in that thread with "@devtool Which tests cover step 1?"
    expect((await reply("@devtool Which tests cover step 1?")).status).toBe(201);

    // Then the line names the thread by its topic and shows the message it follows
    // Owner (Drew, conv 19 msg 544): "is it really clear via the watch which conversation/thread/context I've messaged you from?"
    const [first] = await watchLines(watch, 1, 3_000);
    expect({ thread_root_id: first?.thread_root_id, thread_topic: first?.thread_topic, before: first?.before }).toEqual({
      thread_root_id: root,
      thread_topic: "Can step 1 ship on its own?",
      before: { author: "drew", text: "Can step 1 ship on its own?" },
    });

    // When the agent acks it and the owner replies with a short "@devtool yes"
    const acked = await convoz(w.box, s.sid, ["ack", first!.ack]);
    expect(acked.code, acked.stderr).toBe(0);
    expect((await reply("@devtool yes")).status).toBe(201);

    // Then the line carries the topic and the question the "yes" answers, so the agent need not read the whole thread
    // Owner (Drew, conv 19 msg 561): "do you have to get the whole thread each time? the first / last is probably enough --"
    const [, second] = await watchLines(watch, 2, 5_000);
    expect({ body: second?.body, thread_topic: second?.thread_topic, before: second?.before }).toEqual({
      body: "@devtool yes",
      thread_topic: "Can step 1 ship on its own?",
      before: { author: "drew", text: "@devtool Which tests cover step 1?" },
    });
  } finally {
    watch.stop();
  }
});

scenario("A two-line message stays on one watch line", { tag: ["@cli"] }, async ({ server }) => {
  // Given "convoz watch --json" runs as "devtool"
  const w = await chatWorld(server, { agents: ["devtool"] });
  const conv = await createConversation(w.owner, { title: "Ship search filters", participants: ["devtool"] });
  const s = await startSession(w.box, "devtool", "watch");
  const watch = startWatch(w.box, s.sid);
  try {
    // When the owner posts a two-line message mentioning "@devtool"
    await ownerSays(w.owner, conv, "@devtool line one\nline two");
    await watchLines(watch, 1, 3_000);

    // Then the stream line holds an escaped newline and the output has no extra line
    // (the next message is line 2 and both lines parse as JSON, so the first was not split)
    await ownerSays(w.owner, conv, "after");
    const lines = await watchLines(watch, 2, 5_000);
    expect(lines.map((l) => l.body)).toEqual(["@devtool line one\nline two", "after"]);
    expect(watch.stdout().split("\n")[0]).toContain("\\n");
  } finally {
    watch.stop();
  }
});

scenario("A watch gets every item, even when two arrive together or a poll is cut", { tag: ["@cli", "@lossy"] }, async ({ server }, info) => {
  info.setTimeout(90_000);
  const w = await chatWorld(server, { agents: ["devtool"] });
  const conv41 = await createConversation(w.owner, { title: "Ship search filters", participants: ["devtool"] });
  const conv42 = await createConversation(w.owner, { title: "Release notes", participants: ["devtool"] });
  const s = await startSession(w.box, "devtool", "watch");

  // Given "convoz watch --json" runs as "devtool", and its link loses the answer of one poll without an error
  const link = await pollCut(w.srv.target);
  const via = await machineVia(link.url, w.box2.key, w.box, s.sid);
  const watch = via.start(["watch", "--json", "--sid", s.sid], { timeoutMs: 60_000 });
  let other: Running | undefined;
  try {
    // And the stream printed one line for the owner's first message (the next poll reuses the connection)
    await ownerSays(w.owner, conv41, "first");
    await watchLines(watch, 1, 3_000);

    // When the owner's second message comes in the poll whose answer is lost
    link.arm();
    await ownerSays(w.owner, conv41, "second");
    await link.cut;

    // And another watch of the same session runs, and nobody reads what it prints
    other = startWatch(w.box, s.sid);

    // And the owner posts in conversations 41 and 42 at the same moment
    await Promise.all([ownerSays(w.owner, conv41, "third"), ownerSays(w.owner, conv42, "fourth")]);

    // Then the stream prints one line for each of the owner's messages within 3 seconds
    await watchLines(watch, 4, 3_000).catch(() => []);
    const bodies = watch
      .stdout()
      .split("\n")
      .filter((l) => l !== "")
      .map((l) => (JSON.parse(l) as { body: string }).body);
    expect(bodies.sort()).toEqual(["first", "fourth", "second", "third"]);
  } finally {
    other?.stop();
    watch.stop();
    await link.close();
  }
});

scenario("Watch finishes the item without an ack, and an ack still works", { tag: ["@cli"] }, async ({ server }) => {
  // Given "convoz watch --json" runs as "devtool"
  const w = await chatWorld(server, { agents: ["devtool"] });
  const conv = await createConversation(w.owner, { title: "Ship search filters", participants: ["devtool"] });
  const s = await startSession(w.box, "devtool", "watch");
  const watch = startWatch(w.box, s.sid);
  try {
    // And the owner posts "Is the build green?" in conversation 41, and the stream printed one line for it
    await ownerSays(w.owner, conv, "Is the build green?");
    const [line] = await watchLines(watch, 1, 3_000);

    // Then "convoz inbox --peek" shows no item for conversation 41 (the next poll of the watch finished it; owner msg 821: no ack needed)
    await expect.poll(async () => peekFor(w.box, s.sid, conv), { timeout: 5_000 }).toEqual([]);

    // When "devtool" runs "convoz post 41 'Yes, all 11 checks pass'" and then "convoz ack" with the item from the stream line
    const posted = await convoz(w.box, s.sid, ["post", "--fyi", String(conv), "Yes, all 11 checks pass"]);
    expect(posted.code, posted.stderr).toBe(0);
    const acked = await convoz(w.box, s.sid, ["ack", `${line!.item_id}:${line!.claim_token}`]);
    expect(acked.code, acked.stdout + acked.stderr).toBe(0);

    // Then "convoz inbox --peek" shows no item for conversation 41
    expect(await peekFor(w.box, s.sid, conv)).toEqual([]);
  } finally {
    watch.stop();
  }
});

scenario("Watch stops with exit 3 when its session ends", { tag: ["@cli"] }, async ({ server }) => {
  // Given "convoz watch --json" runs as "devtool"
  const w = await chatWorld(server, { agents: ["devtool"] });
  await createConversation(w.owner, { title: "Ship search filters", participants: ["devtool"] });
  const s = await startSession(w.box, "devtool", "watch");
  const watch = startWatch(w.box, s.sid);
  try {
    // When the session ends (another process ends the lease while the watch waits)
    const ended = await w.box.sessionEnd(s.sid);
    expect(ended.code, ended.stderr).toBe(0);

    // Then "convoz watch" exits 3 and says the session ended
    const res = await exitsWithin(watch, 8_000);
    expect({ code: res?.code, says: /session ended/i.test(res?.stderr ?? "") }).toEqual({ code: 3, says: true });
  } finally {
    watch.stop();
  }
});

// ---- cli-mcp.feature: post, read and ack --------------------------------------------------------------------

scenario("Post prints only the message id", { tag: ["@cli"] }, async ({ server }) => {
  // Given "devtool" is an active participant of conversation 41
  const w = await chatWorld(server, { agents: ["devtool"] });
  const conv = await createConversation(w.owner, { title: "Ship search filters", participants: ["devtool"] });
  const s = await startSession(w.box, "devtool", "post");

  // When "devtool" runs "convoz post 41 'Build is green'"
  const res = await convoz(w.box, s.sid, ["post", "--fyi", String(conv), "Build is green"]);

  // Then the CLI prints one line holding the message id and exits 0
  expect({ code: res.code, stdout: res.stdout.replace(/^\d+\n$/, "<id>\n"), stderr: res.stderr }).toEqual({ code: 0, stdout: "<id>\n", stderr: "" });
});

scenario("Ack removes an item and refuses a stale claim", { tag: ["@cli"] }, async ({ server }) => {
  // Given "devtool" claimed an item for conversation 41 and acked it
  const w = await chatWorld(server, { agents: ["devtool"] });
  const conv = await createConversation(w.owner, { title: "Ship search filters", participants: ["devtool"] });
  const s = await startSession(w.box, "devtool", "ack");
  await ownerSays(w.owner, conv, "Is the build green?");
  const [item] = await inboxItems(w.box, s.sid, ["--claim", "1", "--wait", "0"]);
  const ref = `${item!.id}:${item!.claim_token}`;
  const first = await convoz(w.box, s.sid, ["ack", ref]);
  expect(first.code, first.stdout + first.stderr).toBe(0);

  // When "devtool" acks the same item again
  const again = await convoz(w.box, s.sid, ["ack", ref]);

  // Then the CLI exits 4 with "claim_lost"
  expect({ code: again.code, says: again.stdout.includes("claim_lost") }).toEqual({ code: 4, says: true });
});

scenario("Every command prints its usage for --help", { tag: ["@cli"] }, async ({ server }) => {
  const w = await chatWorld(server, { agents: ["devtool"] });

  // When "convoz watch --help", "convoz ack -h" and "convoz help" run
  const watch = await w.box.run(["watch", "--help"]);
  const ack = await w.box.run(["ack", "-h"]);
  const help = await w.box.run(["help"]);

  // Then each exits 0 and prints to stdout
  for (const r of [watch, ack, help]) expect({ code: r.code, stderr: r.stderr }).toEqual({ code: 0, stderr: "" });

  // And the first two show the synopsis, every flag with its help line and an example
  expect(watch.stdout).toContain("convoz watch [--json]");
  expect(watch.stdout).toContain("-timeout duration\n    \tgive up after this long");
  expect(watch.stdout).toContain("Example:\n  convoz watch");
  expect(ack.stdout).toContain("convoz ack <id>:<token>");
  expect(ack.stdout).toContain("-sid string");
  expect(ack.stdout).toContain("Example:\n  convoz ack");

  // and "convoz help" lists the commands one per line
  expect(help.stdout).toMatch(/^watch +Print one line per new inbox item/m);
  expect(help.stdout).toMatch(/^ack +Remove an item from your inbox/m);
});

/** The command lines of `convoz --help`: every line under "Commands:", as [name, description]. */
function helpCommands(text: string): Array<[string, string]> {
  const lines = text.split("\n");
  const from = lines.indexOf("Commands:");
  expect(from, "convoz --help has a Commands: list").toBeGreaterThan(-1);
  return lines
    .slice(from + 1)
    .filter((l) => l.trim() !== "")
    .map((l): [string, string] => {
      const m = /^(\S+)\s+(\S.*)$/.exec(l);
      return [m?.[1] ?? l, m?.[2] ?? ""];
    });
}

scenario("The CLI help says reply is for threads and post is the normal answer", { tag: ["@cli"] }, async ({ server }) => {
  const w = await chatWorld(server, { agents: ["devtool"] });

  // When "convoz help" and "convoz reply --help" run
  const help = await w.box.run(["help"]);
  const reply = await w.box.run(["reply", "--help"]);

  // Then the "reply" line says "Reply inside a thread" and names "convoz post" for a normal answer
  expect(help.stdout).toMatch(/^reply +Reply inside a thread \(not a normal answer; use convoz post for that\)\./m);
  expect(reply.stdout).toContain("convoz reply: Reply inside a thread (not a normal answer; use convoz post for that).");

  // And "convoz --help" lists post, reply and ask as separate steps
  const overview = (await w.box.run(["--help"])).stdout;
  expect(overview).toMatch(/5\. convoz post +answer in the conversation\n +convoz reply MSG +answer inside a thread only\n +convoz ask +give the owner options\n/);
  expect(overview).not.toContain("convoz post, convoz reply");
});

scenario("Every command has a description in convoz --help", { tag: ["@cli"] }, async ({ server }) => {
  const w = await chatWorld(server, { agents: ["devtool"] });

  // When "convoz --help" runs
  const help = await w.box.run(["--help"]);

  // Then it exits 0 and prints to stdout
  expect({ code: help.code, stderr: help.stderr }).toEqual({ code: 0, stderr: "" });

  // And every command it lists has a one-line description next to its name
  const commands = helpCommands(help.stdout);
  const names = commands.map(([n]) => n);
  for (const n of ["serve", "version", "backup", "restore", "keys", "workspace", "mcp", "man", "login", "watch", "ack"]) expect(names).toContain(n);
  for (const [name, text] of commands) expect(text.length, `${name} has a description`).toBeGreaterThan(10);
});

scenario("convoz --help explains how Convoz works", { tag: ["@cli"] }, async ({ server }) => {
  const w = await chatWorld(server, { agents: ["devtool"] });

  // When "convoz --help" runs
  const help = await w.box.run(["--help"]);
  const overview = help.stdout.slice(0, Math.max(help.stdout.indexOf("Commands:"), 0));

  // Then it says what Convoz is: the owner and agents in conversations
  expect(overview).toMatch(/owner/i);
  expect(overview).toMatch(/agents?/i);
  expect(overview).toMatch(/conversations?/i);

  // And it lists the steps of an agent: login, whoami and brief, watch or inbox, read, post, reply or ask, then ack
  const order = ["convoz login", "convoz whoami", "convoz brief", "convoz watch", "convoz inbox", "convoz read", "convoz post", "convoz reply", "convoz ask", "convoz ack"];
  const at = order.map((o) => overview.indexOf(o, Math.max(overview.indexOf("convoz login"), 0)));
  expect(at.every((i) => i >= 0), `steps in order: ${at}`).toBe(true);
  expect([...at].sort((a, b) => a - b)).toEqual(at);

  // And it explains asks, apps, files and invites for agents outside the tailnet
  for (const word of ["ask", "app", "--file", "convoz file", "convoz invite", "tailnet"]) expect(overview).toContain(word);

  // And it says where the config lives and that "convoz <command> --help" gives detail
  expect(overview).toContain("~/.config/convoz");
  expect(overview).toContain("convoz <command> --help");
});

scenario("convoz man prints a man page that matches the help", { tag: ["@cli"] }, async ({ server }) => {
  const w = await chatWorld(server, { agents: ["devtool"] });
  const help = await w.box.run(["--help"]);

  // When "convoz man" runs
  const man = await w.box.run(["man"]);

  // Then it exits 0 and prints a man page on stdout
  expect({ code: man.code, stderr: man.stderr }).toEqual({ code: 0, stderr: "" });
  expect(man.stdout).toMatch(/^\.TH CONVOZ 1/m);

  // And the man page holds the overview and every command with the same description as "convoz --help"
  const plain = man.stdout.replaceAll("\\-", "-").replaceAll("\\e", "\\");
  const overview = help.stdout.slice(help.stdout.indexOf("\n\n") + 2, Math.max(help.stdout.indexOf("Commands:"), 0));
  for (const line of overview.split("\n").filter((l) => l.trim() !== "")) expect(plain, `overview line: ${line}`).toContain(line.trim());
  for (const [name, text] of helpCommands(help.stdout)) {
    expect(plain, `${name} description`).toContain(text);
    expect(plain, `${name} section`).toMatch(new RegExp(`^\\.SS ${name}$`, "m"));
  }

  // And "man -l -" can show it
  const shown = spawnSync("man", ["-l", "-"], { input: man.stdout, encoding: "utf8", timeout: 20_000, shell: false, env: { PATH: process.env.PATH ?? "", MANWIDTH: "200", MANPAGER: "cat", LANG: "C" } });
  expect({ code: shown.status, stderr: shown.stderr }).toEqual({ code: 0, stderr: "" });
  expect(shown.stdout).toContain("NAME");
  expect(shown.stdout).toContain("convoz");
});

scenario("A watch line carries a ready ack and ack takes three forms", { tag: ["@cli"] }, async ({ server }) => {
  // Given "convoz watch" printed items for conversations 41, 52 and 63
  const w = await chatWorld(server, { agents: ["devtool"] });
  const convs = [
    await createConversation(w.owner, { title: "Ship search filters", participants: ["devtool"] }),
    await createConversation(w.owner, { title: "Deploy alerts runbook", participants: ["devtool"] }),
    await createConversation(w.owner, { title: "Release notes", participants: ["devtool"] }),
  ];
  const s = await startSession(w.box, "devtool", "ackforms");
  const json = startWatch(w.box, s.sid);
  let lines;
  try {
    for (const c of convs.slice(0, 2)) await ownerSays(w.owner, c, "Is the build green?");
    lines = await watchLines(json, 2, 5_000);
  } finally {
    json.stop();
  }
  expect(lines[0]!.ack).toBe(`${lines[0]!.item_id}:${lines[0]!.claim_token}`);

  // When "devtool" acks one with "<id> <token>", one with the watch line on stdin, and one with the "ack" text of a plain watch line
  // (each ack comes before the next watch starts: a new watch takes the claims over)
  const two = await convoz(w.box, s.sid, ["ack", String(lines[0]!.item_id), lines[0]!.claim_token]);
  const piped = await convoz(w.box, s.sid, ["ack", "-"], JSON.stringify(lines[1]) + "\n");
  const text = w.box.start(["watch", "--sid", s.sid], { timeoutMs: 25_000 });
  let textRef: string;
  try {
    await ownerSays(w.owner, convs[2]!, "Is the build green?");
    textRef = (await text.waitForStdout(/\(ack: convoz ack (\d+:\S+)\)/, 5_000))[1]!;
  } finally {
    text.stop();
  }
  const plain = await convoz(w.box, s.sid, ["ack", textRef]);
  for (const r of [two, piped, plain]) expect(r.code, r.stdout + r.stderr).toBe(0);

  // Then the three items are gone from the inbox
  for (const c of convs) expect(await peekFor(w.box, s.sid, c)).toEqual([]);

  // And "convoz ack 1" exits 2 and names the accepted forms
  const wrong = await convoz(w.box, s.sid, ["ack", "1"]);
  expect(wrong.code).toBe(2);
  expect(wrong.stderr).toContain("convoz ack <id>:<token>... | convoz ack <id> <token> | convoz ack -");
});

// ---- conversations.feature -----------------------------------------------------------------------------------

scenario("An agent reads what the owner wrote", { tag: ["@cli"] }, async ({ server }) => {
  // Given the owner sent "Is the build green?" in conversation 41
  const w = await chatWorld(server, { agents: ["devtool"] });
  const conv = await createConversation(w.owner, { title: "Ship search filters", participants: ["devtool"] });
  const s = await startSession(w.box, "devtool", "read");
  await ownerSays(w.owner, conv, "Is the build green?");

  // When "devtool" runs "convoz read 41"
  const res = await convoz(w.box, s.sid, ["read", String(conv)]);

  // Then the output shows "@drew" and "Is the build green?"
  expect(res.stdout).toMatch(/^#\d+ @drew \d{4}-\d\d-\d\dT\S+\n  Is the build green\?\n/m);

  // And a flag after the conversation id works, and a message cannot send control sequences to the terminal
  await ownerSays(w.owner, conv, "plain \u001b[31mred\u001b]0;pwned\u0007 text");
  const last = await convoz(w.box, s.sid, ["read", String(conv), "--since", String(1), "--limit", "5"]);
  expect(last.code, last.stderr).toBe(0);
  expect(last.stdout).toContain("plain [31mred]0;pwned text");
  expect(last.stdout).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/);
});
