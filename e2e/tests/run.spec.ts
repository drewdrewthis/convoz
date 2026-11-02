import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chatWorld, createConversation, exitsWithin, messagesOf, ownerSays, peekFor, startSession } from "../lib/chat.ts";
import { baseEnv, convozBin, expect, scenario, test } from "../lib/scenario.ts";
import type { Owner } from "../lib/owner.ts";

// `convoz run`: one short-lived process per inbox item. Generic mode runs a script (node, by argv); Claude mode runs a stub `claude`.
// The scripts reply with the real `convoz` binary through the CONVOZ_SID the runner gives them.

const scratch = () => fs.mkdtempSync(path.join(os.tmpdir(), "convoz-run-"));

/** A script that node runs: written to a mktemp dir, never through a shell. */
function script(dir: string, name: string, body: string): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, `import fs from "node:fs";\nimport { execFileSync } from "node:child_process";\nconst convoz = ${JSON.stringify(convozBin)};\n${body}\n`);
  return file;
}

/** The thread under one message, as the owner reads it: the bodies of the replies. */
const threadOf = async (owner: Owner, conv: number, root: number) => (await messagesOf(owner, conv, `thread=${root}`)).map((m) => `${m.author.handle}: ${m.body}`);

scenario("convoz run answers an item with a fresh process and acks it", { tag: ["@cli"] }, async ({ server }) => {
  // Given "convoz run --as devtool -- <script>" runs, where the script replies to the item it is given
  const w = await chatWorld(server, { agents: ["devtool"] });
  const conv = await createConversation(w.owner, { title: "Ship search filters", participants: ["devtool"] });
  const dir = scratch();
  const seen = path.join(dir, "seen.json");
  const answer = script(
    dir,
    "answer.mjs",
    `const item = JSON.parse(fs.readFileSync(0, "utf8"));
const e = process.env;
fs.writeFileSync(${JSON.stringify(seen)}, JSON.stringify({ item, conv: e.CONVOZ_CONV, message: e.CONVOZ_MESSAGE, id: e.CONVOZ_ITEM, as: e.CONVOZ_AS }));
execFileSync(convoz, ["post", "--fyi", e.CONVOZ_CONV, "on it"]);`,
  );
  const runner = w.box.start(["run", "--as", "devtool", "--", process.execPath, answer], { timeoutMs: 40_000 });
  try {
    await runner.waitForStdout(/serving @devtool/);

    // When the owner posts "@devtool is the build green?" in conversation 41
    const msg = await ownerSays(w.owner, conv, "@devtool is the build green?");

    // Then conversation 41 shows one reply from "devtool" within 10 seconds
    await expect.poll(async () => (await messagesOf(w.owner, conv)).filter((m) => m.author.handle === "devtool").map((m) => m.body), { timeout: 10_000 }).toEqual(["on it"]);

    // And the script got the item on stdin and its conversation, message and item in its environment
    const got = JSON.parse(fs.readFileSync(seen, "utf8"));
    expect([got.conv, got.message, got.as, got.item.message.body]).toEqual([String(conv), String(msg), "devtool", "@devtool is the build green?"]);
    expect(got.id).toBe(String(got.item.id));

    // And the inbox of "devtool" is empty
    const s = await startSession(w.box, "devtool", "peek");
    await expect.poll(async () => (await peekFor(w.box, s.sid, conv)).length, { timeout: 10_000 }).toBe(0);
  } finally {
    runner.stop();
  }
});

scenario("A failing command is retried once, then the thread says it could not answer", { tag: ["@cli"] }, async ({ server }) => {
  test.setTimeout(60_000);
  // Given "convoz run --as devtool -- <script>" runs, where the script fails on every item
  const w = await chatWorld(server, { agents: ["devtool"] });
  const conv = await createConversation(w.owner, { title: "Ship search filters", participants: ["devtool"] });
  const dir = scratch();
  const seen = path.join(dir, "seen.log");
  const fail = script(
    dir,
    "fail.mjs",
    `fs.appendFileSync(${JSON.stringify(seen)}, JSON.stringify(process.env.CONVOZ_MESSAGE) + "\\n");
const item = JSON.parse(fs.readFileSync(0, "utf8"));
if (item.message.body.includes("reply first")) execFileSync(convoz, ["reply", "--fyi", process.env.CONVOZ_MESSAGE, "done, then it broke"]);
process.stderr.write("boom\\n");
process.exit(1);`,
  );
  const runner = w.box.start(["run", "--as", "devtool", "--", process.execPath, fail], { timeoutMs: 50_000 });
  try {
    await runner.waitForStdout(/serving @devtool/);

    // When the owner posts "@devtool deploy it" in conversation 41
    const msg = await ownerSays(w.owner, conv, "@devtool deploy it");

    // Then conversation 41 shows "I couldn't answer this" from "devtool" once
    await expect.poll(() => threadOf(w.owner, conv, msg), { timeout: 20_000 }).toEqual([expect.stringMatching(/^devtool: I couldn.t answer this .*boom/)]);
    expect(fs.readFileSync(seen, "utf8").trim().split("\n"), "the command ran twice").toHaveLength(2);

    // And the inbox of "devtool" is empty
    const s = await startSession(w.box, "devtool", "peek");
    await expect.poll(async () => (await peekFor(w.box, s.sid, conv)).length, { timeout: 10_000 }).toBe(0);

    // And when a script replies to an item and then fails, the thread shows that one reply and no second one
    const second = await ownerSays(w.owner, conv, "@devtool reply first");
    await expect.poll(() => threadOf(w.owner, conv, second), { timeout: 20_000 }).toEqual(["devtool: done, then it broke"]);
    await expect.poll(async () => (await peekFor(w.box, s.sid, conv)).length, { timeout: 10_000 }).toBe(0);
    expect(await threadOf(w.owner, conv, second), "no second answer").toEqual(["devtool: done, then it broke"]);
    expect(fs.readFileSync(seen, "utf8").trim().split("\n").filter((l) => l === JSON.stringify(String(second)))).toHaveLength(1);
  } finally {
    runner.stop();
  }
});

scenario("A second watcher is refused while convoz run serves the agent", { tag: ["@cli"] }, async ({ server, testApi }) => {
  test.setTimeout(90_000);
  // Given "convoz run --as devtool -- <script>" runs on "box-2"
  const w = await chatWorld(server, { agents: ["devtool"] });
  const conv = await createConversation(w.owner, { title: "Ship search filters", participants: ["devtool"] });
  const dir = scratch();
  const quiet = script(dir, "quiet.mjs", "process.exit(0);");
  const argv = ["run", "--as", "devtool", "--", process.execPath, quiet];
  const first = w.box.start(argv, { timeoutMs: 40_000 });
  const other = await startSession(w.box, "devtool", "other");
  await first.waitForStdout(/serving @devtool/);

  // When "convoz watch --as devtool" runs from another session
  const refused = await w.box.run(["watch", "--sid", other.sid], { timeoutMs: 15_000 });

  // Then it prints "@devtool is served by convoz run on box-2" and exits 3
  expect({ code: refused.code, stderr: refused.stderr.includes("@devtool is served by convoz run on box-2") }).toEqual({ code: 3, stderr: true });

  // And "convoz inbox --peek" and "convoz post" for "devtool" still work
  expect((await w.box.run(["inbox", "--peek", "--sid", other.sid])).code).toBe(0);
  expect((await w.box.run(["post", "--fyi", String(conv), "hello", "--sid", other.sid])).code).toBe(0);

  // And a watch that is already open when "convoz run" starts makes the run wait and say "another convoz watch or run holds @devtool", not exit 3
  first.stop();
  expect((await first.done).code, "a stopped runner lets go at once").toBe(0);
  const open = w.box.start(["watch", "--sid", other.sid], { timeoutMs: 40_000 });
  try {
    expect(await exitsWithin(open, 1_500), "the watch is open").toBeNull();
    const late = w.box.start(argv, { timeoutMs: 15_000 });
    expect(await exitsWithin(late, 7_000), "the run waits for the slot").toBeNull();
    late.stop();
    expect((await late.done).stderr).toContain("another convoz watch or run holds @devtool");
  } finally {
    open.stop();
  }
  await open.done;

  // And 30 seconds after the runner stopped, "convoz watch --as devtool" works again
  // The server starts the watch's 30 s from when it sees the poll end, which can come after the process exited and after the clock
  // moved. A runner refused then holds nothing, so the clock moves on once more (once: a slot that never frees still fails).
  const serving = async (last: boolean) => {
    await testApi(w.srv).advanceClock(31_000);
    const run = w.box.start(argv, { timeoutMs: 8_000 }); // the harness kills it: no clean end, so only the clock lets go
    const served = await run.waitForStdout(/serving @devtool/).then(() => true, (err: Error) => (last || !/already has a convoz watch open/.test(err.message) ? Promise.reject(err) : false));
    return served ? run : null;
  };
  const killed = (await serving(false)) ?? (await serving(true))!;
  await killed.done;
  const within = await w.box.run(["watch", "--once", "--timeout", "2s", "--sid", other.sid], { timeoutMs: 15_000 });
  expect(within.stderr, "still held in the grace time").toContain("served by convoz run");
  await testApi(w.srv).advanceClock(31_000);
  const after = await w.box.run(["watch", "--once", "--timeout", "2s", "--sid", other.sid], { timeoutMs: 15_000 });
  expect(after.stderr, "free again").toContain("no item arrived");
});

scenario("A second convoz run for the same agent on the same machine is refused", { tag: ["@cli"] }, async ({ server }) => {
  // Given "convoz run --as devtool -- <script>" runs on "box-2"
  const w = await chatWorld(server, { agents: ["devtool"] });
  const conv = await createConversation(w.owner, { title: "Ship search filters", participants: ["devtool"] });
  const dir = scratch();
  const answer = script(dir, "answer.mjs", `execFileSync(convoz, ["post", "--fyi", process.env.CONVOZ_CONV, "still here"]);`);
  const argv = ["run", "--as", "devtool", "--", process.execPath, answer];
  const first = w.box.start(argv, { timeoutMs: 40_000 });
  try {
    await first.waitForStdout(/serving @devtool/);

    // When "convoz run --as devtool -- <script>" runs again on "box-2"
    const again = await w.box.run(argv, { timeoutMs: 15_000 });

    // Then it exits 1 with "already running (pid" and the first run keeps serving
    expect({ code: again.code, stderr: again.stderr.includes("already running (pid ") }).toEqual({ code: 1, stderr: true });
    await ownerSays(w.owner, conv, "@devtool ping");
    await expect.poll(async () => (await messagesOf(w.owner, conv)).filter((m) => m.author.handle === "devtool").length, { timeout: 10_000 }).toBe(1);
  } finally {
    first.stop();
  }
});

scenario("Claude mode builds a claude command with every tool and keeps one session", { tag: ["@cli"] }, async ({ server }) => {
  test.setTimeout(90_000);
  // Given a stub "claude" command on PATH that records its argv and replies to the item
  const w = await chatWorld(server, { agents: ["devtool"] });
  const conv = await createConversation(w.owner, { title: "Ship search filters", participants: ["devtool"] });
  const dir = scratch();
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  const log = path.join(dir, "argv.log");
  const stub = path.join(bin, "claude");
  fs.writeFileSync(
    stub,
    `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const argv = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(argv) + "\\n");
const at = Math.max(argv.indexOf("--session-id"), argv.indexOf("--resume"));
const sid = argv[at + 1];
const prompt = argv[at + 2];
const dir = path.join(process.env.HOME, ".claude", "projects", "stub");
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, sid + ".jsonl"), "{}\\n");
if (prompt.includes("one-line summary")) { console.log("SUMMARY-TESTONLY: answered two questions"); process.exit(0); }
const m = /conv (\\d+) .* #(\\d+) @/.exec(prompt);
execFileSync(${JSON.stringify(convozBin)}, ["reply", "--fyi", m[2], "answered"]);
`,
    { mode: 0o755 },
  );
  const runner = w.box.start(["run", "--as", "devtool", "--fresh-after", "2"], { timeoutMs: 70_000, env: { PATH: `${bin}:${baseEnv().PATH ?? ""}` } });
  try {
    await runner.waitForStdout(/serving @devtool/);

    // When the owner posts three questions to "devtool" one after another
    const ids: number[] = [];
    for (const q of ["one?", "two?", "three?"]) {
      const id = await ownerSays(w.owner, conv, `@devtool ${q}`);
      ids.push(id);
      await expect.poll(() => threadOf(w.owner, conv, id), { timeout: 15_000 }).toEqual(["devtool: answered"]);
    }

    // Then the stub was given the "bypassPermissions" mode and a spend limit every time
    const calls: string[][] = fs.readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const asks = calls.filter((c) => !c.some((a) => a.includes("one-line summary")));
    expect(asks).toHaveLength(3);
    for (const c of asks) {
      const flag = (n: string) => c[c.indexOf(n) + 1] ?? "";
      expect(c[0]).toBe("-p");
      expect(flag("--permission-mode")).toBe("bypassPermissions");
      expect(flag("--max-budget-usd")).toBe("2.00");

      // And the stub got no tool list
      expect(c).not.toContain("--allowedTools");
      expect(c).not.toContain("--disallowedTools");
    }

    // And the first call starts a session and the second resumes it
    const sess = (c: string[], f: string) => c[c.indexOf(f) + 1];
    expect(asks[0]).toContain("--session-id");
    expect(asks[1]).toContain("--resume");
    expect(sess(asks[1]!, "--resume")).toBe(sess(asks[0]!, "--session-id"));

    // And the third call starts a new session whose prompt holds the summary of the first, and the summary is kept as a handoff note
    expect(asks[2]).toContain("--session-id");
    expect(sess(asks[2]!, "--session-id")).not.toBe(sess(asks[0]!, "--session-id"));
    expect(asks[2]!.join("\n")).toContain("Summary of earlier work: SUMMARY-TESTONLY: answered two questions");
    const s = await startSession(w.box, "devtool", "notes");
    const notes = await w.box.run(["handoff", "--list", "--sid", s.sid], { timeoutMs: 15_000 });
    expect(notes.stdout).toContain("SUMMARY-TESTONLY: answered two questions");
  } finally {
    runner.stop();
  }
});

// Owner said (msg 366): "Maybe the message schema should require a true/false field that says if it requires an action/decision from the user -- this will differentiate regular messages from actual blocking requests. We can probably do a lot of powerful stuff with the schema and validation"
scenario("Claude mode tells the child to post with --fyi", { tag: ["@cli"] }, async ({ server }) => {
  test.setTimeout(60_000);
  // Given a stub "claude" command on PATH that records its argv and replies to the item
  const w = await chatWorld(server, { agents: ["devtool"] });
  const conv = await createConversation(w.owner, { title: "Ship search filters", participants: ["devtool"] });
  const dir = scratch();
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  const log = path.join(dir, "argv.log");
  fs.writeFileSync(
    path.join(bin, "claude"),
    `#!${process.execPath}
const fs = require("node:fs");
const { execFileSync } = require("node:child_process");
const argv = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(argv) + "\\n");
const prompt = argv[argv.indexOf("--session-id") + 2] ?? "";
const m = /conv (\\d+) .* #(\\d+) @/.exec(prompt);
if (m) execFileSync(${JSON.stringify(convozBin)}, ["reply", "--fyi", m[2], "answered"]);
`,
    { mode: 0o755 },
  );
  // And "convoz run --as devtool" runs
  const runner = w.box.start(["run", "--as", "devtool"], { timeoutMs: 45_000, env: { PATH: `${bin}:${baseEnv().PATH ?? ""}` } });
  try {
    await runner.waitForStdout(/serving @devtool/);

    // When the owner posts a question to "devtool"
    const id = await ownerSays(w.owner, conv, "@devtool is it green?");
    await expect.poll(() => threadOf(w.owner, conv, id), { timeout: 15_000 }).toEqual(["devtool: answered"]);

    // Then the prompt the stub was given tells it to answer with "convoz reply --fyi" or "convoz post --fyi"
    const prompt = (JSON.parse(fs.readFileSync(log, "utf8").trim().split("\n")[0]!) as string[]).join("\n");
    expect(prompt).toContain("convoz reply --fyi");
    expect(prompt).toContain("convoz post --fyi");
  } finally {
    runner.stop();
  }
});
