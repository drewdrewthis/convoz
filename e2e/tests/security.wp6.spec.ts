import { installedMachine } from "../lib/cli.ts";
import { chatWorld, exitsWithin, inboxItems, startSession } from "../lib/chat.ts";
import { conversationsWithMentions } from "../lib/inbox.ts";
import { allow, loginMachine, stepped } from "../lib/machines.ts";
import { expect, scenario } from "../lib/scenario.ts";

// Binding of the inbox half of security.feature (contracts): a key regeneration ends the polls and frees the claims.

scenario("Regenerating a key ends its long polls and frees its claims", { tag: ["@cli", "@api"] }, async ({ server }) => {
  // Given a "devtool" session on "box-2" waits with "convoz inbox --wait 60" and holds 2 claimed items
  // (one session of "box-2" claims the 2 items; a second one waits, because a poll returns the items its session holds at once)
  const w = await chatWorld(server, { agents: ["devtool"] });
  await conversationsWithMentions(w.owner, 2, "devtool");
  const holder = await startSession(w.box, "devtool", "holder");
  const waiter = await startSession(w.box, "devtool", "waiter");
  expect(await inboxItems(w.box, holder.sid, ["--claim", "2", "--wait", "0"])).toHaveLength(2);
  const waiting = w.box.start(["inbox", "--json", "--sid", waiter.sid, "--wait", "60"], { timeoutMs: 30_000 });
  try {
    // And a "devtool" session on "laptop-1" is live
    const laptopKey = await loginMachine(w.srv, w.owner, "laptop-1", allow("devtool"));
    const laptop = await installedMachine(w.srv.origin, "laptop-1", laptopKey.key);
    const onLaptop = await startSession(laptop, "devtool", "laptop");
    expect(await exitsWithin(waiting, 700)).toBeNull();

    // When the owner regenerates the key of "box-2"
    const regen = await stepped(w.owner, "POST", `/api/machines/${w.box2.id}/regenerate`, {}, "machine.regenerate", w.box2.id);
    expect(regen.status, regen.text).toBe(200);

    // Then the waiting long poll ends within 1 second
    const ended = await exitsWithin(waiting, 1_000);
    expect(ended, "the waiting long poll did not end within 1 s").not.toBeNull();
    expect(ended!.code).toBe(3);

    // And the 2 items are ready again for the "laptop-1" session
    const freed = await inboxItems(laptop, onLaptop.sid, ["--claim", "5", "--wait", "0"]);
    expect(freed).toHaveLength(2);
  } finally {
    waiting.stop();
  }
});
