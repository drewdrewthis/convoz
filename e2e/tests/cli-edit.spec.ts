import { agentPost, convoz, createConversation, messagesOf, ownerSays, peekFor, startSession, unreadOf } from "../lib/chat.ts";
import { must } from "../lib/owner.ts";
import { expect, scenario } from "../lib/scenario.ts";
import { world } from "../lib/wp3.ts";

/*
 * CONVOZ EDIT: specs/features/cli-mcp.feature, the two "convoz edit" scenarios. Owner goal, conv 308 msg 5755.
 * Contract: `convoz edit <message> <text|->` sends PATCH /api/messages/:id {client_id, body} with the session's lease. The author
 * gets 200 and the message with edited_at; anyone else 403 "Only the author may do that." (exit 3). An edit pulls no one in (E-18):
 * no inbox item, no unread.
 */

/** The message `id` of conversation `conv` as the owner reads it. */
async function messageOf(owner: Parameters<typeof messagesOf>[0], conv: number, id: number) {
  const m = (await messagesOf(owner, conv)).find((r) => r.id === id) as ({ body: string; edited_at?: number } & { id: number }) | undefined;
  if (!m) throw new Error(`message ${id} is not in conversation ${conv}`);
  return m;
}

scenario("An agent edits its own message with convoz edit", { tag: ["@cli"] }, async ({ server }) => {
  // Given "devtool" posted "Build is gren" in conversation 41 with "docs"
  const w = await world(server);
  const conv = await createConversation(w.owner, { participants: ["devtool", "docs"] });
  const dev = await startSession(w.box, "devtool", "devtool");
  const docs = await startSession(w.box, "docs", "docs");
  const id = must(await agentPost(w.srv, dev.lease, conv, "Build is gren"), "post", 201).json().id as number;
  const unreadBefore = await unreadOf(w.owner, conv);
  const docsBefore = await peekFor(w.box, docs.sid, conv);

  // When "devtool" runs "convoz edit <id> -" with "Build is green, @docs please check" on standard input
  const res = await convoz(w.box, dev.sid, ["edit", String(id), "-"], "Build is green, @docs please check\n");

  // Then the CLI exits 0
  expect(res.code, res.stderr).toBe(0);

  // And the owner reads "Build is green, @docs please check" with an edited time
  const m = await messageOf(w.owner, conv, id);
  expect(m.body).toBe("Build is green, @docs please check");
  expect(m.edited_at ?? 0).toBeGreaterThan(0);

  // And "docs" gets no inbox item and the owner's unread count does not change
  expect(await peekFor(w.box, docs.sid, conv)).toEqual(docsBefore);
  expect(await unreadOf(w.owner, conv)).toBe(unreadBefore);
});

scenario("An agent cannot edit another's message with convoz edit", { tag: ["@cli"] }, async ({ server }) => {
  // Given the owner posted "Ship it" in conversation 41
  const w = await world(server);
  const conv = await createConversation(w.owner, { participants: ["devtool"] });
  const id = await ownerSays(w.owner, conv, "Ship it");
  const dev = await startSession(w.box, "devtool", "devtool");

  // When "devtool" runs "convoz edit <id> 'Hold it'"
  const res = await convoz(w.box, dev.sid, ["edit", String(id), "Hold it"]);

  // Then the CLI exits 3 and says only the author may do that
  expect(res.code, res.stderr).toBe(3);
  expect(res.stderr).toContain("Only the author may do that.");

  // And the message still reads "Ship it"
  const m = await messageOf(w.owner, conv, id);
  expect(m.body).toBe("Ship it");
  expect(m.edited_at ?? 0).toBe(0);
});
