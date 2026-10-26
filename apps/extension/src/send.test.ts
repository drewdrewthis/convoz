import assert from "node:assert/strict";
import { test } from "node:test";
import { newAttempt, sendPage, type SendApi, type SendInput } from "./send.ts";
import type { Capture } from "./tab.ts";

const page = { url: "https://news.example.com/a", title: "A story", selection: "" };

function fakeApi(failPosts = 0) {
  const calls: string[] = [];
  const posts: { conversation: number; clientId: string; uploads: string[] }[] = [];
  const api: SendApi = {
    async createConversation(clientId, title, handle) {
      calls.push(`create ${clientId} ${title} ${handle}`);
      return 7;
    },
    async uploadPng() {
      calls.push("upload");
      return "u1";
    },
    async post(conversation, clientId, _body, uploads) {
      calls.push("post");
      if (failPosts-- > 0) throw new Error("Send failed: down.");
      posts.push({ conversation, clientId, uploads });
    },
  };
  return { api, calls, posts };
}

const input = (read: Partial<Capture> = {}, screenshot = true): SendInput & { asked: boolean[] } => {
  const asked: boolean[] = [];
  return {
    handle: "scout",
    note: "look",
    screenshot,
    asked,
    async capture(withScreenshot) {
      asked.push(withScreenshot);
      return { page, png: withScreenshot ? new Blob(["png"]) : null, selectionLost: false, screenshotLost: false, ...read };
    },
  };
};

test("a send makes the conversation, puts the screenshot up and posts the message with it", async () => {
  const { api, calls, posts } = fakeApi();
  const attempt = newAttempt();
  assert.deepEqual(await sendPage(api, input(), attempt), { conversation: 7, notes: [] });
  assert.deepEqual(calls, [`create ${attempt.conversationClientId} A story scout`, "upload", "post"]);
  assert.deepEqual(posts, [{ conversation: 7, clientId: attempt.messageClientId, uploads: ["u1"] }]);
});

test("a retry after the message failed reuses the conversation, the screenshot and the message's client id", async () => {
  const { api, calls, posts } = fakeApi(1);
  const attempt = newAttempt();
  const first = input();
  await assert.rejects(sendPage(api, first, attempt));
  assert.equal(attempt.conversation, 7);
  const again = input();
  assert.equal((await sendPage(api, again, attempt)).conversation, 7);
  assert.deepEqual(again.asked, [false]); // the screenshot is up already
  assert.equal(calls.filter((c) => c.startsWith("create")).length, 1);
  assert.equal(calls.filter((c) => c === "upload").length, 1);
  assert.deepEqual(posts, [{ conversation: 7, clientId: attempt.messageClientId, uploads: ["u1"] }]);
});

test("a selection that cannot be read and a screenshot that failed each say so", async () => {
  const { api } = fakeApi();
  assert.deepEqual((await sendPage(api, input({ selectionLost: true }), newAttempt())).notes, ["This page cannot be captured, so its selected text did not go."]);
  assert.deepEqual((await sendPage(api, input({ screenshotLost: true, png: null }), newAttempt())).notes, ["The screenshot could not be taken, so it did not go."]);
});

test("without a screenshot nothing is put up", async () => {
  const { api, calls, posts } = fakeApi();
  await sendPage(api, input({}, false), newAttempt());
  assert.ok(!calls.includes("upload"));
  assert.deepEqual(posts[0]?.uploads, []);
});
