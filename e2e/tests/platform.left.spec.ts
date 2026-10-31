import { agentPost, chatWorld, createConversation, ownerPost, startSession } from "../lib/chat.ts";
import { answerAsk, askBody, nowOf, postAsk } from "../lib/asks.ts";
import { ownerDeletes as deleteMessage, pageOf, type WireMessage } from "../lib/messages-wp4.ts";
import { clientId, plainDb } from "../lib/machines.ts";
import { must } from "../lib/owner.ts";
import { expect, scenario } from "../lib/scenario.ts";
import { idsOf, ownerAdds, ownerRemoves } from "../lib/wp3.ts";

// Bindings of contracts/platform.feature that the event backbone work package left open. "Cross-record rules hold when a client tries to
// break them" waits for the apps host (a via_app message) and "Events never carry content" waits for uploads.

/** A small seeded generator, so a failing sequence can be run again (mulberry32). */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Every message of the main list as the owner sees it (tombstones included), oldest first. */
async function mainListOf(owner: Parameters<typeof pageOf>[0], conv: number): Promise<WireMessage[]> {
  const all: WireMessage[] = [];
  let page = await pageOf(owner, conv, "limit=100");
  while (page.length > 0) {
    all.unshift(...page);
    page = page.length < 100 ? [] : await pageOf(owner, conv, `limit=100&before=${page[0]!.id}`);
  }
  return all;
}

scenario("Counters match the messages after any sequence of actions", { tag: ["@api"] }, async ({ server, dataDir, testApi }, info) => {
  info.setTimeout(150_000);
  // Given a random sequence of 1000 posts, replies, deletes, asks, answers and removals across 5 conversations
  const w = await chatWorld(server, { agents: ["devtool"], env: { CONVOZ_TEST_PLAINTEXT: "1" } });
  const convs: number[] = [];
  for (let i = 1; i <= 5; i++) convs.push(await createConversation(w.owner, { title: `Topic ${i}`, participants: ["devtool"] }));
  const agent = await startSession(w.box, "devtool", "counter");
  const devtool = (await idsOf(w.owner)).devtool!;
  const rnd = seeded(20261017);
  const pick = <T,>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)]!;
  const messages: { id: number; conv: number; root: number }[] = []; // what was posted, to reply to or delete
  const asks: { id: number; conv: number }[] = [];
  const refused = new Set([403, 404, 409, 429]);
  // An agent's budget of messages refills with time: the test clock moves on when the server says how long to wait.
  const patient = async (call: () => Promise<Awaited<ReturnType<typeof ownerPost>>>) => {
    const res = await call();
    if (res.status !== 429) return res;
    await testApi(w.srv).advanceClock(((res.json().error?.retry_after ?? 60) + 1) * 1000);
    return call();
  };
  const must5xx = (status: number, what: string) => expect(status, what).toBeLessThan(500);

  for (let step = 0; step < 1000; step++) {
    const conv = pick(convs);
    const roll = rnd();
    if (roll < 0.3) {
      const res = await ownerPost(w.owner, conv, `owner says ${step}`);
      must5xx(res.status, `owner post ${step}`);
      if (res.status === 201) messages.push({ id: res.json().id, conv, root: 0 });
    } else if (roll < 0.45) {
      const res = await patient(() => agentPost(w.srv, agent.lease, conv, `agent says ${step}`));
      must5xx(res.status, `agent post ${step}`);
      if (res.status === 201) messages.push({ id: res.json().id, conv, root: 0 });
    } else if (roll < 0.65) {
      const roots = messages.filter((m) => m.conv === conv && m.root === 0);
      if (roots.length === 0) continue;
      const root = pick(roots);
      const reply = await w.owner.client.post(`/api/conversations/${conv}/messages`, { client_id: clientId(), body: `reply ${step}`, thread_root_id: root.id });
      must5xx(reply.status, `reply ${step}`);
      if (reply.status === 201) messages.push({ id: reply.json().id, conv, root: root.id });
    } else if (roll < 0.75) {
      const target = messages.length ? pick(messages) : undefined;
      if (!target) continue;
      must5xx((await deleteMessage(w.owner, target.id)).status, `delete ${step}`);
    } else if (roll < 0.85) {
      const res = await patient(() => postAsk(w.srv, agent.lease, askBody(conv, { question: `Answer the question ${step}?` })));
      must5xx(res.status, `ask ${step}`);

      if (res.status === 201) asks.push({ id: res.json().ask.id, conv });
    } else if (roll < 0.95) {
      if (asks.length === 0) continue;
      const res = await answerAsk(w.owner, pick(asks).id, { choice: "recommended" });
      must5xx(res.status, `answer ${step}`);
      expect(res.status === 200 || refused.has(res.status), `answer ${step}: ${res.status}`).toBe(true);
    } else {
      const res = await ownerRemoves(w.owner, conv, devtool);
      must5xx(res.status, `removal ${step}`);
      if (rnd() < 0.7) must5xx((await ownerAdds(w.owner, conv, devtool)).status, `re-add ${step}`);
    }
  }
  expect(messages.length, "the sequence did something").toBeGreaterThan(300);
  expect(messages.filter((m) => m.root !== 0).length, "the sequence replied").toBeGreaterThan(30);
  expect(asks.length, "the sequence asked").toBeGreaterThan(30);

  // When the rail and each conversation are loaded
  const rail = must(await w.owner.client.get("/api/conversations"), "rail").json().conversations as { id: number }[];
  expect(rail.map((c) => c.id).sort()).toEqual([...convs].sort());
  const db = plainDb(dataDir);
  try {
    for (const conv of convs) {
      const main = (await mainListOf(w.owner, conv)).filter((m) => m.kind !== "system");
      const counters = db.prepare("SELECT message_count, open_ask_count FROM conversations WHERE id = ?").get(conv) as { message_count: number; open_ask_count: number };

      // Then every message count, reply count and open-ask count equals a count of the visible items
      expect([conv, "messages", counters.message_count]).toEqual([conv, "messages", main.length]);
      const open = (await nowOf(w.owner)).asks.filter((a) => a.conversation_id === conv && a.state === "open").length;
      expect([conv, "open asks", counters.open_ask_count]).toEqual([conv, "open asks", open]);
      for (const root of main.filter((m) => (m.reply_count ?? 0) > 0)) {
        // a deleted root has no thread to open: its replies are counted in the data file
        const stored = (db.prepare("SELECT COUNT(*) AS n FROM messages WHERE thread_root_id = ?").get(root.id) as { n: number }).n;
        expect([conv, "replies of", root.id, root.reply_count]).toEqual([conv, "replies of", root.id, stored]);
        if (root.deleted) continue;
        const thread = must(await w.owner.client.get(`/api/messages/${root.id}/replies`), `thread ${root.id}`).json().messages as unknown[];
        expect([conv, "visible replies of", root.id, thread.length]).toEqual([conv, "visible replies of", root.id, root.reply_count]);
      }
    }
  } finally {
    db.close();
  }
});
