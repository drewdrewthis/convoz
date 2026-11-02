import { createConversation, openStream, ownerSays, startSession } from "../lib/chat.ts";
import { askBody, postAsk } from "../lib/asks.ts";
import { deltaFrom, snapshotOf, type SyncEvent } from "../lib/event.ts";
import { chatWorld } from "../lib/chat.ts";
import { must } from "../lib/owner.ts";
import { png, postWith, uploadWhole } from "../lib/uploads-wp10.ts";
import { expect, scenario } from "../lib/scenario.ts";

/*
 * PLATFORM (WP18): the binding of "Events never carry content" (specs/contracts/platform.feature, I-23, AC-22).
 * The routes are the ones at the top of lib/event.ts: GET /api/sync?cursor= (thin events), GET /api/stream (hydrated frames).
 */

const SEEDS = { body: "body-ZQX1", title: "title-ZQX2", question: "Answer the question-ZQX3 now?", option: "option-ZQX4", file: "file-ZQX5.png" };

scenario("Events never carry content", { tag: ["@api"] }, async ({ server }) => {
  // Given seeded strings "body-ZQX1", "title-ZQX2", "question-ZQX3", "option-ZQX4" and "file-ZQX5.png"
  const w = await chatWorld(server, { agents: ["devtool"] });
  const devtool = await startSession(w.box, "devtool", "events");
  const start = (await snapshotOf(w.owner)).cursor;
  const stream = await openStream(w.srv, w.owner.client);

  // When the owner and "devtool" create a conversation, a 16 KB message, an ask and an upload that use them
  const conv = await createConversation(w.owner, { participants: ["devtool"], title: SEEDS.title });
  const big = `${SEEDS.body} ${"lorem ipsum ".repeat(Math.ceil(16 * 1024 / 12))}`.slice(0, 16 * 1024);
  await ownerSays(w.owner, conv, big);
  must(await postAsk(w.srv, devtool.lease, askBody(conv, { question: SEEDS.question, rec: [SEEDS.option, "Because it is the safe one"] })), "ask", 201);
  const file = await uploadWhole({ srv: w.srv, lease: devtool.lease }, conv, "image", SEEDS.file, png(8, 8, true));
  const withFile = await postWith({ srv: w.srv, lease: devtool.lease }, conv, "Here is the picture", [file.id]);
  expect(withFile.status, withFile.text).toBe(201);

  // Then no event payload in GET /api/sync is longer than 1 KB
  const events: SyncEvent[] = [];
  for (let cursor = start, more = true; more; ) {
    const page = await deltaFrom(w.owner, cursor);
    events.push(...page.events);
    cursor = page.cursor;
    more = page.more;
  }
  expect(events.length, "the actions wrote events").toBeGreaterThanOrEqual(4);
  const longest = events.map((e) => ({ type: e.type, bytes: Buffer.byteLength(JSON.stringify(e.payload)) })).sort((a, b) => b.bytes - a.bytes)[0]!;
  expect(longest.bytes, `the longest payload is a ${longest.type}`).toBeLessThanOrEqual(1024);

  // And no event payload contains any seeded string
  const leaks = events.flatMap((e) => Object.values(SEEDS).filter((s) => JSON.stringify(e).includes(s)).map((s) => `${e.type} holds ${s}`));
  expect(leaks).toEqual([]);

  // And the hydrated frames on the event stream do show the content
  await stream.waitFor((f) => JSON.stringify(f.data).includes(SEEDS.file));
  const framed = JSON.stringify(stream.frames.map((f) => f.data));
  stream.close();
  expect(Object.values(SEEDS).filter((s) => !framed.includes(s)), "seeded strings the hydrated frames do not show").toEqual([]);
});
