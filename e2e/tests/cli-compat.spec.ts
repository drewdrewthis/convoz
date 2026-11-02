import { chatWorld, convoz, createConversation, ownerSays, startSession } from "../lib/chat.ts";
import { expect, scenario } from "../lib/scenario.ts";

// The previous CLI keeps working against this server. In CI the step "Previous CLI against this server" sets CONVOZ_CLI_BIN to a CLI
// built from the base branch; both sides report the version "cli-compat", so the check is about the API and not about the commit
// (the commit always differs between a base and a head). Without CONVOZ_CLI_BIN it runs the current CLI, which must pass too.

scenario("The previous CLI still does its basic commands against this server", { tag: ["@cli"] }, async ({ server }) => {
  const w = await chatWorld(server, { agents: ["devtool"], env: { CONVOZ_TEST_VERSION: "cli-compat" } });
  const conv = await createConversation(w.owner, { title: "Compat", participants: ["devtool"] });
  const s = await startSession(w.box, "devtool", "s1");

  // whoami takes no --sid or --timeout, so it is run as it is; the base CLI may know fewer flags than the head one.
  const who = await w.box.run(["whoami"]);
  expect(who.code, who.stderr).toBe(0);

  await ownerSays(w.owner, conv, "hello from the owner");
  const inbox = await convoz(w.box, s.sid, ["inbox", "--peek", "--json"]);
  expect(inbox.code, inbox.stderr).toBe(0);

  const read = await convoz(w.box, s.sid, ["read", String(conv)]);
  expect(read.code, read.stderr).toBe(0);
  expect(read.stdout).toContain("hello from the owner");

  const post = await convoz(w.box, s.sid, ["post", "--fyi", String(conv), "hello from the agent"]);
  expect(post.code, post.stderr).toBe(0);
});
