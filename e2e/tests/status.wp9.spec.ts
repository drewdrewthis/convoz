import { chatWorld, convoz, createConversation, startSession } from "../lib/chat.ts";
import { send } from "../lib/http.ts";
import { bearer } from "../lib/machines.ts";
import { expect, scenario } from "../lib/scenario.ts";

interface CrewStatus {
  handle: string;
  state: string;
  doing: string;
  next: string;
  online: boolean;
}

scenario("Status updates show in Crew", { tag: ["@cli"] }, async ({ server }) => {
  // Background: owner "drew", machine "box-2" with allow-list "devtool", "devtool" in conversation 41
  const w = await chatWorld(server, { agents: ["devtool"] });
  await createConversation(w.owner, { title: "Ship search filters", participants: ["devtool"] });
  const s = await startSession(w.box, "devtool", "status");

  // When "devtool" runs "convoz status --state working --doing 'Fixing #412' --next 'Open PR'"
  const res = await convoz(w.box, s.sid, ["status", "--state", "working", "--doing", "Fixing #412", "--next", "Open PR"]);
  expect(res.code, res.stderr).toBe(0);

  // Then Crew shows "devtool" as "working" with "Fixing #412"
  const crew = (await w.owner.client.get("/api/status")).json().statuses as CrewStatus[];
  expect(crew.find((c) => c.handle === "devtool")).toMatchObject({ state: "working", doing: "Fixing #412", next: "Open PR", online: true });

  // And a state that is not one of the four is refused
  const bad = await send(w.srv.target, "PUT", "/api/status", { json: { state: "napping" }, ...bearer(s.lease) });
  expect(bad.status).toBe(400);
});
