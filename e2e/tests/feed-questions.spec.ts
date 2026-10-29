import { agentPost, agentSays, inboxItems, messagesOf, ownerSays, peekFor } from "../lib/chat.ts";
import { send } from "../lib/http.ts";
import { bearer } from "../lib/machines.ts";
import { planWorld, type PlanWorld } from "../lib/plan.ts";
import { expect, scenario } from "../lib/scenario.ts";

// contracts/feed-items.feature, "An agent takes a question of the owner". The contract:
//   POST /api/messages/:id/take (lease) {question?, context, steps?, plan?} -> {items: [FeedItem]}
//   POST /api/conversations/:id/items/:key/answer (lease) {outcome}

const take = (p: PlanWorld, lease: string, msg: number, body: Record<string, unknown>) =>
  send(p.w.srv.target, "POST", `/api/messages/${msg}/take`, { json: { context: "He asked in the main chat", ...body }, ...bearer(lease) });
const feed = async (p: PlanWorld) => (await p.w.owner.client.request("GET", "/api/feed")).json();
const ownerReplies = (p: PlanWorld, root: number, body: string) =>
  p.w.owner.client.post(`/api/conversations/${p.conv}/messages`, { client_id: `o-${Math.random().toString(36).slice(2)}-${Date.now()}`, body, thread_root_id: root });
const find = (f: any, key: string) => f.items.find((i: any) => i.key === key);

scenario("Taking a question makes started items on his message and posts nothing", { tag: ["@api"] }, async ({ server }) => {
  const p = await planWorld(server);
  const msg = await ownerSays(p.w.owner, p.conv, "Why is the search slow?");
  const before = (await messagesOf(p.w.owner, p.conv)).length;
  const got = await take(p, p.dev.lease, msg, { question: "Why is the search slow", steps: ["Profile the query"] });
  expect(got.status, got.text).toBe(200);
  const [q, step] = got.json().items;
  expect([q.state, q.title, q.thread_root_id, q.plan]).toEqual(["started", "Why is the search slow", msg, "main"]);
  expect([step.state, step.thread_root_id]).toEqual(["pending", msg]);
  expect((await messagesOf(p.w.owner, p.conv)).length).toBe(before);
  expect(find(await feed(p), q.key)?.state).toBe("started");
  // An agent's message and a reply in a thread cannot be taken
  const agentMsg = await agentSays(p.w.srv, p.docs.lease, p.conv, "Status");
  expect((await take(p, p.dev.lease, agentMsg, { question: "Q" })).status).toBe(400);
  const reply = (await ownerReplies(p, msg, "In the thread")).json().id;
  expect((await take(p, p.dev.lease, reply, { question: "Q" })).status).toBe(400);
  expect((await take(p, p.dev.lease, msg, { question: "Q", context: "" })).status).toBe(400);
});

scenario("A second take of a message needs its own question", { tag: ["@api"] }, async ({ server }) => {
  const p = await planWorld(server);
  const msg = await ownerSays(p.w.owner, p.conv, "Why slow");
  expect((await take(p, p.dev.lease, msg, {})).json().items[0].title).toBe("Why slow");
  expect((await take(p, p.dev.lease, msg, {})).status).toBe(409);
  const second = await take(p, p.dev.lease, msg, { question: "And who owns billing" });
  expect(second.status, second.text).toBe(200);
  expect(second.json().items[0].title).toBe("And who owns billing");
});

scenario("His reply closes every item on the message, an answer reopens only its own, a plain reply the rest", { tag: ["@api"] }, async ({ server }) => {
  const p = await planWorld(server);
  const msg = await ownerSays(p.w.owner, p.conv, "Q1 and Q2");
  const q1 = (await take(p, p.dev.lease, msg, { question: "Q1" })).json().items[0];
  const q2 = (await take(p, p.dev.lease, msg, { question: "Q2" })).json().items[0];
  expect(find(await feed(p), q1.key)).toBeDefined();
  expect((await ownerReplies(p, msg, "Thanks, take your time")).status).toBe(201);
  expect((await feed(p)).items).toEqual([]);
  const ans = await send(p.w.srv.target, "POST", `/api/conversations/${p.conv}/items/${q1.key}/answer`, { json: { outcome: "The index is missing" }, ...bearer(p.dev.lease) });
  expect(ans.status, ans.text).toBe(200);
  expect(ans.json().state).toBe("done");
  const after = await feed(p);
  expect([...after.items, ...after.done].some((i: any) => i.key === q1.key && !i.acked_at)).toBe(true);
  expect(find(after, q2.key)).toBeUndefined();
  const thread = await messagesOf(p.w.owner, p.conv, `thread=${msg}`);
  expect(thread[thread.length - 1].body).toBe("> Q1\n\nThe index is missing");
  expect(await agentPost(p.w.srv, p.dev.lease, p.conv, "More on Q2", { thread_root_id: msg }).then((r) => r.status)).toBe(201);
  expect(find(await feed(p), q2.key)).toBeDefined();
});

scenario("Another agent's reply wakes the owner of an open item, and an acked item wakes nobody", { tag: ["@api", "@cli"] }, async ({ server }) => {
  const p = await planWorld(server);
  const msg = await ownerSays(p.w.owner, p.conv, "Q");
  const q = (await take(p, p.dev.lease, msg, { question: "Q" })).json().items[0];
  await inboxItems(p.w.box, p.dev.sid, ["--claim", "20", "--wait", "0"]);
  expect(await peekFor(p.w.box, p.dev.sid, p.conv)).toEqual([]);
  expect((await agentPost(p.w.srv, p.docs.lease, p.conv, "I know this one", { thread_root_id: msg })).status).toBe(201);
  expect((await peekFor(p.w.box, p.dev.sid, p.conv)).length).toBe(1);
  expect((await send(p.w.srv.target, "POST", `/api/conversations/${p.conv}/items/${q.key}/done`, { json: {}, ...bearer(p.docs.lease) })).status).toBe(404);
  await inboxItems(p.w.box, p.dev.sid, ["--claim", "20", "--wait", "0"]);
  expect((await ownerReplies(p, msg, "Okay")).status).toBe(201);
  await inboxItems(p.w.box, p.dev.sid, ["--claim", "20", "--wait", "0"]);
  expect((await agentPost(p.w.srv, p.docs.lease, p.conv, "More detail", { thread_root_id: msg })).status).toBe(201);
  expect(await peekFor(p.w.box, p.dev.sid, p.conv)).toEqual([]);
});
