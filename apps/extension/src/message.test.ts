import assert from "node:assert/strict";
import { test } from "node:test";
import { PAGE_INTRO, SELECTION_MAX, conversationTitle, formatMessage } from "./message.ts";

const page = { url: "https://news.example.com/a", title: "A story", selection: "" };
const block = `${PAGE_INTRO}\nA story\nhttps://news.example.com/a`;

// the rule of scanMentions (apps/convoz/internal/server/message/mention.go): ASCII "@" not after a word character, then 2 to 40 of
// a-z, 0-9 and "-", starting with a-z and not followed by a word character
const mentions = (body: string) => [...body.matchAll(/(?<![A-Za-z0-9_])@([a-z][a-z0-9-]{1,39})(?![A-Za-z0-9_])/g)].map((m) => m[1]);

test("the message mentions the agent with the note, then the page block: the intro line, the title and the URL", () => {
  assert.equal(formatMessage("scout", "  Can you check this?  ", page), `@scout Can you check this?\n\n${block}`);
  assert.equal(formatMessage("scout", "", page), `@scout\n\n${block}`);
});

test("the selection is a quote, line by line, after a blank line", () => {
  assert.equal(formatMessage("scout", "", { ...page, selection: "one\r\ntwo" }), `@scout\n\n${block}\n\n> one\n> two`);
});

test("Markdown characters in the title, URL and selection go in unchanged", () => {
  const body = formatMessage("scout", "", { url: "https://en.wikipedia.org/wiki/Go_(game)?q=[1]", title: "Ship *it* [now]", selection: "Agents _read_ `this` [x](y) \\" });
  assert.equal(body, `@scout\n\n${PAGE_INTRO}\nShip *it* [now]\nhttps://en.wikipedia.org/wiki/Go_(game)?q=[1]\n\n> Agents _read_ \`this\` [x](y) \\`);
});

test("the page's text mentions no one: every @ in the title, URL and selection becomes ＠", () => {
  const body = formatMessage("scout", "ask @ada too", { url: "https://x.example/@other-agent", title: "Hi @other-agent", selection: "cc @other-agent\n@root" });
  const [line1, ...rest] = body.split("\n");
  assert.equal(line1, "@scout ask @ada too");
  assert.ok(!rest.join("\n").includes("@"));
  assert.ok(rest.join("\n").includes("＠other-agent"));
  assert.deepEqual(mentions(body), ["scout", "ada"]);
});

test("any URL goes in as it is, on its own line", () => {
  for (const url of ["javascript:alert(1)", "chrome://extensions/", "file:///home/drew/notes.txt"]) {
    assert.equal(formatMessage("scout", "", { ...page, url }).split("\n")[4], url);
  }
});

test("a title on several lines becomes one line, without control or bidi marks; an empty title leaves only the URL", () => {
  assert.equal(formatMessage("scout", "", { ...page, title: "A\nstory\u202E" }).split("\n")[3], "A story");
  assert.equal(formatMessage("scout", "", { ...page, title: " \n " }), `@scout\n\n${PAGE_INTRO}\nhttps://news.example.com/a`);
});

test("a long selection is clipped", () => {
  const body = formatMessage("scout", "", { ...page, selection: "a".repeat(SELECTION_MAX + 50) });
  assert.equal(body.split("\n")[6]!.length, "> ".length + SELECTION_MAX);
});

test("the conversation title is the page title on one line, clipped, without control or bidi marks", () => {
  assert.equal(conversationTitle("  A\nstory\u202E  "), "A story");
  assert.equal(conversationTitle("x".repeat(200))?.length, 120);
  assert.equal(conversationTitle(" \n "), undefined);
});
