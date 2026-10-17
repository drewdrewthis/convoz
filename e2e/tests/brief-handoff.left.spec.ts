import { send } from "../lib/http.ts";
import { inboxWorld } from "../lib/left.ts";
import { bearer, lease as mintLease } from "../lib/machines.ts";
import { expect, scenario } from "../lib/scenario.ts";

// Binding of contracts/brief-handoff.feature that the agent-surface work package left open.

scenario("Another agent cannot read the handoff notes of devtool", { tag: ["@api"] }, async ({ server }) => {
  // Given an agent session as "docs"
  const { w, s1 } = await inboxWorld(server);
  const note = await w.box.run(["handoff", "--sid", s1.sid, "--timeout", "10s", "Halfway through #412"], { timeoutMs: 20_000 });
  expect(note.code, note.stderr).toBe(0);
  const docs = await mintLease(w.srv, w.box2.key, { as: "docs" });
  expect((await send(w.srv.target, "GET", "/api/handoffs", bearer(docs))).status, "docs reads its own notes").toBe(200);

  // When it calls GET /api/handoffs for identity "devtool"
  const res = await send(w.srv.target, "GET", "/api/handoffs?identity=devtool", bearer(docs));

  // Then the server answers 403
  expect(res.status).toBe(403);
  expect(res.text).not.toContain("Halfway through #412");
});
