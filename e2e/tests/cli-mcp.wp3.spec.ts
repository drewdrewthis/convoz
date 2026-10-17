import { convoz, createConversation, ownerSays } from "../lib/chat.ts";
import { expect, scenario } from "../lib/scenario.ts";
import { handlesOf, linesOf, startSession, viewOf, world } from "../lib/wp3.ts";

// WP3's part of cli-mcp.feature: an agent joins a conversation only through a human, and leaves by itself. The routes are listed at
// the top of tests/conversations.wp3.spec.ts; `convoz add <conv> @agent` and `convoz leave <conv>` call them with the agent's lease.

// ---- Rule: Agents join conversations only through a human -----------------------------------------------------

scenario("An agent's add request waits for a human", { tag: ["@cli"] }, async ({ server }) => {
  // Background: conversation 41 has "devtool"; "docs" is on box-2 too
  const w = await world(server);
  const conv = await createConversation(w.owner, { title: "Ship search filters", participants: ["devtool"] });
  await ownerSays(w.owner, conv, "Is the build green?");
  const dev = await startSession(w.box, "devtool", "devtool");
  const docs = await startSession(w.box, "docs", "docs");

  // When "devtool" runs "convoz add 41 @docs"
  const res = await convoz(w.box, dev.sid, ["add", String(conv), "@docs"]);
  expect(res.code, res.stderr).toBe(0);
  expect(res.stdout).toContain("@docs pending");

  // Then the owner sees a pending add "@docs" in Now
  const view = await viewOf(w.owner, conv);
  expect(view.pending?.map((p) => `@${p.person.handle} asked by @${p.requested_by?.handle}`)).toEqual(["@docs asked by @devtool"]);
  expect(handlesOf(view)).toEqual(["drew", "devtool"]);

  // And "docs" cannot read conversation 41
  const read = await convoz(w.box, docs.sid, ["read", String(conv)]);
  expect(read.code).toBe(3);
  expect(read.stdout).not.toContain("Is the build green?");
});

scenario("An agent leaves a conversation", { tag: ["@cli"] }, async ({ server }) => {
  // Background: conversation 41 has "devtool"
  const w = await world(server);
  const conv = await createConversation(w.owner, { title: "Ship search filters", participants: ["devtool"] });
  await ownerSays(w.owner, conv, "Is the build green?");
  const dev = await startSession(w.box, "devtool", "devtool");
  expect((await convoz(w.box, dev.sid, ["read", String(conv)])).code).toBe(0);

  // When "devtool" runs "convoz leave 41"
  const left = await convoz(w.box, dev.sid, ["leave", String(conv)]);
  expect(left.code, left.stderr).toBe(0);

  // Then conversation 41 shows the system line "@devtool left"
  const lines = await linesOf(w.owner, conv);
  expect(lines.filter((l) => l.author.kind === "system").map((l) => l.body)).toEqual(["@devtool left"]);
  expect(handlesOf(await viewOf(w.owner, conv))).toEqual(["drew"]);

  // And "convoz read 41" exits 3
  expect((await convoz(w.box, dev.sid, ["read", String(conv)])).code).toBe(3);
});
