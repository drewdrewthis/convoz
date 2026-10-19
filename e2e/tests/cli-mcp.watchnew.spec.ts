import { chatWorld, convoz, createConversation, exitsWithin, ownerSays, peekFor, startSession } from "../lib/chat.ts";
import { expect, scenario } from "../lib/scenario.ts";

// `convoz watch --once`: the same claim and ack as `watch`, but the command ends after the first batch (exit 3 when --timeout passes with nothing).

const lines = (out: string) => out.split("\n").filter(Boolean).map((l) => JSON.parse(l));

scenario("convoz watch --once prints the waiting item and exits", { tag: ["@cli"] }, async ({ server }) => {
  // Given the owner posted "Is the build green?" in conversation 41 for "devtool"
  const w = await chatWorld(server, { agents: ["devtool"] });
  const conv = await createConversation(w.owner, { title: "Ship search filters", participants: ["devtool"] });
  const s = await startSession(w.box, "devtool", "once");
  await ownerSays(w.owner, conv, "@devtool Is the build green?");

  // When "devtool" runs "convoz watch --json --once"
  const res = await w.box.run(["watch", "--json", "--once", "--sid", s.sid], { timeoutMs: 20_000 });

  // Then it prints one JSON line for that message and exits 0
  expect(res.code, res.stderr).toBe(0);
  const got = lines(res.stdout);
  expect(got.map((l) => [l.body, l.conversation_id])).toEqual([["@devtool Is the build green?", conv]]);

  // And "convoz inbox --peek" still shows the item until the agent acks it
  expect((await peekFor(w.box, s.sid, conv)).map((i) => i.id)).toEqual([got[0].item_id]);
});

scenario("convoz watch --once waits for the next item, then exits", { tag: ["@cli"] }, async ({ server }) => {
  // Given "devtool" runs "convoz watch --json --once" and nothing is waiting
  const w = await chatWorld(server, { agents: ["devtool"] });
  const conv = await createConversation(w.owner, { title: "Ship search filters", participants: ["devtool"] });
  const s = await startSession(w.box, "devtool", "once-wait");
  const watch = w.box.start(["watch", "--json", "--once", "--sid", s.sid], { timeoutMs: 25_000 });
  try {
    expect(await exitsWithin(watch, 1_500), "the command waits while nothing arrives").toBeNull();

    // When the owner posts "@devtool yes" in conversation 41
    await ownerSays(w.owner, conv, "@devtool yes");

    // Then the command prints one JSON line for that message within 3 seconds and exits 0
    const res = await exitsWithin(watch, 3_000);
    expect(res?.code, res?.stderr).toBe(0);
    const got = lines(res!.stdout);
    expect(got.map((l) => l.body)).toEqual(["@devtool yes"]);

    // When the agent acks the item
    const acked = await convoz(w.box, s.sid, ["ack", `${got[0].item_id}:${got[0].claim_token}`]);
    expect(acked.code, acked.stderr).toBe(0);

    // Then "convoz watch --json --once --timeout 2s" with nothing waiting prints nothing and exits 3
    const quiet = await w.box.run(["watch", "--json", "--once", "--timeout", "2s", "--sid", s.sid], { timeoutMs: 20_000 });
    expect({ code: quiet.code, stdout: quiet.stdout }).toEqual({ code: 3, stdout: "" });
  } finally {
    watch.stop();
  }
});
