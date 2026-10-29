import { agentSays, messagesOf } from "../lib/chat.ts";
import { send } from "../lib/http.ts";
import { bearer } from "../lib/machines.ts";
import { planWorld, type PlanWorld } from "../lib/plan.ts";
import { expect, scenario } from "../lib/scenario.ts";

// features/feed-items.feature and contracts/feed-items.feature. The contract:
//   POST /api/conversations/:id/items/:key/:event  (lease, scope status; event start|block|done|fyi|drop|say) {title?, context?, recommend?, outcome?}
//   GET /api/feed (owner) -> {items: [FeedItem], done: [FeedItem]}; POST /api/feed/:id/accept {if_version}, /answer {text, resolves?}, /ack;
//   PUT /api/feed/:id/snooze {until}, DELETE /api/feed/:id/snooze.

const item = (p: PlanWorld, lease: string, key: string, event: string, body: Record<string, unknown> = {}) =>
  send(p.w.srv.target, "POST", `/api/conversations/${p.conv}/items/${key}/${event}`, { json: body, ...bearer(lease) });
const ownerPost = (p: PlanWorld, path: string, json: Record<string, unknown> = {}) => p.w.owner.client.request("POST", path, { csrf: true, json });
const feed = async (p: PlanWorld) => (await p.w.owner.client.request("GET", "/api/feed")).json();
const states = (f: any) => f.items.map((i: any) => `${i.key}:${i.state}`);

scenario("The next step starts by itself when the one now is done", { tag: ["@cli"] }, async ({ server }) => {
  const p = await planWorld(server);
  // The sub-command comes right after "item", before the common flags, so this does not go through the convoz() helper.
  const run = (sid: string, sub: string, ...rest: string[]) => p.w.box.run(["item", sub, "--sid", sid, "--timeout", "10s", ...rest], { timeoutMs: 20_000 });
  expect((await run(p.dev.sid, "start", String(p.conv), "chips", "Reply chip")).code).toBe(0);
  expect((await run(p.dev.sid, "start", String(p.conv), "load", "Faster first load")).code).toBe(0);
  expect(states(await feed(p))).toEqual(["chips:started", "load:pending"]);
  const done = await run(p.dev.sid, "done", String(p.conv), "chips", "Shipped");
  expect(done.code, done.stderr).toBe(0);
  expect((await run(p.docs.sid, "start", String(p.conv), "own", "Docs pass")).code).toBe(0);
  const f = await feed(p);
  expect(states(f)).toEqual(["load:started", "own:started"]);
  expect(f.done.map((i: any) => i.key)).toEqual(["chips"]);
});

scenario("Two blocking requests by one agent: the second is pending and is promoted when the first is accepted", { tag: ["@api"] }, async ({ server }) => {
  const p = await planWorld(server);
  const body = { title: "Decide", recommend: "Go" };
  const a = (await item(p, p.dev.lease, "a", "block", body)).json();
  expect((await item(p, p.dev.lease, "b", "block", body)).status).toBe(200);
  expect(states(await feed(p))).toEqual(["a:blocking", "b:pending"]);
  const acc = await ownerPost(p, `/api/feed/${a.id}/accept`, { if_version: a.version });
  expect(acc.status, acc.text).toBe(200);
  expect(acc.json().state).toBe("done");
  expect(states(await feed(p))).toEqual(["b:blocking"]);
  for (let i = 0; i < 12; i++) expect((await item(p, p.dev.lease, `m${i}`, "block", body)).status).toBe(200);
});

scenario("Every move that the state does not allow answers 409 and changes nothing", { tag: ["@api"] }, async ({ server }) => {
  const p = await planWorld(server);
  const a = (await item(p, p.dev.lease, "a", "start", { title: "Work" })).json();
  expect((await item(p, p.dev.lease, "a", "fyi", { outcome: "x" })).status).toBe(409);
  const after = (await feed(p)).items[0];
  expect([after.state, after.version]).toEqual(["started", a.version]);
  expect((await item(p, p.docs.lease, "a", "done")).status).toBe(404);
  const asOwner = await p.w.owner.client.request("POST", `/api/conversations/${p.conv}/items/a/done`, { csrf: true, json: {} });
  expect([401, 403]).toContain(asOwner.status);
});

scenario("A stale Accept answers 409, and no recommendation means no Accept", { tag: ["@api"] }, async ({ server }) => {
  const p = await planWorld(server);
  const first = (await item(p, p.dev.lease, "a", "block", { title: "Decide", recommend: "Go" })).json();
  expect((await item(p, p.dev.lease, "a", "block", { title: "Decide again", recommend: "Wait" })).status).toBe(200);
  const stale = await ownerPost(p, `/api/feed/${first.id}/accept`, { if_version: first.version });
  expect(stale.status).toBe(409);
  expect(states(await feed(p))).toEqual(["a:blocking"]);
  const c = (await item(p, p.docs.lease, "c", "block", { title: "Which key?" })).json();
  expect(c.can_accept).toBe(false);
  const no = await ownerPost(p, `/api/feed/${c.id}/accept`, { if_version: c.version });
  expect(no.status).toBe(409);
  expect(no.json().error.code).toBe("no_recommendation");
  const ans = await ownerPost(p, `/api/feed/${c.id}/answer`, { text: "Use staging", resolves: true });
  expect(ans.status, ans.text).toBe(200);
  expect(ans.json().state).toBe("done");
});

scenario("Got it sets acked_at and leaves the state; snooze sets the wake time", { tag: ["@api"] }, async ({ server }) => {
  const p = await planWorld(server);
  const a = (await item(p, p.dev.lease, "a", "block", { title: "Decide", recommend: "Go" })).json();
  expect((await item(p, p.dev.lease, "a", "fyi", { outcome: "Did it myself" })).status).toBe(200);
  const got = await ownerPost(p, `/api/feed/${a.id}/ack`);
  expect(got.status, got.text).toBe(200);
  expect(got.json().state).toBe("fyi");
  expect(got.json().acked_at).toBeGreaterThan(0);
  expect((await feed(p)).items).toEqual([]);
  const b = (await item(p, p.dev.lease, "b", "start", { title: "Work" })).json();
  const okB = await ownerPost(p, `/api/feed/${b.id}/ack`);
  expect(okB.status, okB.text).toBe(200);
  expect(okB.json().state).toBe("started");
  expect((await feed(p)).items).toEqual([]);
  expect((await item(p, p.dev.lease, "b", "block", { title: "Work", recommend: "" })).status).toBe(200);
  expect((await feed(p)).items.map((i: { id: number }) => i.id)).toEqual([b.id]);
  const until = Date.now() + 3_600_000;
  const sn = await p.w.owner.client.request("PUT", `/api/feed/${b.id}/snooze`, { csrf: true, json: { until } });
  expect(sn.status, sn.text).toBe(200);
  expect(sn.json().snoozed_until).toBe(until);
  expect((await p.w.owner.client.request("PUT", `/api/feed/${b.id}/snooze`, { csrf: true, json: { until: 1000 } })).status).toBe(400);
  for (const path of ["/api/feed"]) expect([401, 403]).toContain((await send(p.w.srv.target, "GET", path, { ...bearer(p.dev.lease) })).status);
  expect([401, 403]).toContain((await send(p.w.srv.target, "POST", `/api/feed/${b.id}/ack`, { json: {}, ...bearer(p.dev.lease) })).status);
});

scenario("Markdown, links and over-long text are refused with 400", { tag: ["@api"] }, async ({ server }) => {
  const p = await planWorld(server);
  const x = (n: number) => "x".repeat(n);
  expect((await item(p, p.dev.lease, "k", "start", { title: "See https://example.com" })).status).toBe(400);
  for (const body of [{ title: x(201) }, { title: "T", context: x(2001) }, { title: "T", recommend: x(501) }]) {
    expect((await item(p, p.dev.lease, "k", "block", body)).status).toBe(400);
  }
  expect((await item(p, p.dev.lease, "k", "block", { title: x(200), context: x(2000), recommend: x(500) })).status).toBe(200);
});

scenario("Making and moving an item posts no message; the owner's first reply starts the thread", { tag: ["@api"] }, async ({ server }) => {
  const p = await planWorld(server);
  const before = (await messagesOf(p.w.owner, p.conv)).length;
  const made = (await item(p, p.dev.lease, "a", "block", { title: "Merge the filters", recommend: "Go" })).json();
  expect(made.thread_root_id ?? 0).toBe(0);
  expect((await messagesOf(p.w.owner, p.conv)).length).toBe(before);
  const first = await ownerPost(p, `/api/feed/${made.id}/reply`, { text: "Go, but wait for CI" });
  expect(first.status, first.text).toBe(200);
  const root = first.json().thread_root_id;
  expect(root).toBeGreaterThan(0);
  const rows = await messagesOf(p.w.owner, p.conv);
  expect(rows.find((m) => m.id === root)?.body).toBe("> Merge the filters\n\nGo, but wait for CI");
  const second = (await ownerPost(p, `/api/feed/${made.id}/reply`, { text: "Any news?" })).json();
  expect(second.thread_root_id).toBe(root);
  expect((await messagesOf(p.w.owner, p.conv, `thread=${root}`)).map((m) => m.body)).toContain("Any news?");
  expect([401, 403]).toContain((await send(p.w.srv.target, "POST", `/api/feed/${made.id}/reply`, { json: { text: "x" }, ...bearer(p.dev.lease) })).status);
});

scenario("The owner's reply closes the item and an agent's reply in its thread reopens it, even when snoozed", { tag: ["@api"] }, async ({ server }) => {
  const p = await planWorld(server);
  const made = (await item(p, p.dev.lease, "a", "block", { title: "Merge the filters", recommend: "Go" })).json();
  expect((await feed(p)).items.map((i: { id: number }) => i.id)).toEqual([made.id]);
  const first = await ownerPost(p, `/api/feed/${made.id}/reply`, { text: "Go, but wait for CI" });
  expect(first.status, first.text).toBe(200);
  expect(first.json().acked_at).toBeGreaterThan(0);
  expect(first.json().state).toBe("blocking");
  const root = first.json().thread_root_id;
  const listed = async () => (await feed(p)).items.find((i: { id: number }) => i.id === made.id);
  expect(await listed()).toBeUndefined();
  const until = Date.now() + 3_600_000;
  const sn = await p.w.owner.client.request("PUT", `/api/feed/${made.id}/snooze`, { csrf: true, json: { until } });
  expect(sn.status, sn.text).toBe(200);
  await agentSays(p.w.srv, p.dev.lease, p.conv, "No thread here");
  expect(await listed()).toBeUndefined();
  const said = await send(p.w.srv.target, "POST", `/api/conversations/${p.conv}/messages`, { json: { client_id: `c-${Date.now()}`, body: "CI is green", thread_root_id: root, needs_you: false }, ...bearer(p.dev.lease) });
  expect(said.status, said.text).toBe(201);
  const back = await listed();
  expect(back).toBeDefined();
  expect(back?.acked_at ?? 0).toBe(0);
  expect(back?.snoozed_until ?? 0).toBe(0);
});
