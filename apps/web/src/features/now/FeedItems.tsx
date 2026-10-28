import type { FeedItem } from "@convoz/api-client";
import { Button } from "@convoz/ui/Button";
import { useCallback, useEffect, useState } from "react";
import { call, client, humanError } from "../../shared/api.ts";
import { data, useData, useLive } from "../../shared/data.ts";
import { useNotice } from "../../shared/notice.tsx";
import { ItemFrame } from "./ItemFrame.tsx";

/** The feed items the server keeps (GET /api/feed): one step of an agent's work each. Read next to what Now shows today; a member who is not
 *  the owner is refused, and the section stays out. Pending steps are not cards: they are listed by title under the step that is now. */
export function FeedItems() {
  const { fail } = useNotice();
  const [feed, setFeed] = useState<readonly FeedItem[] | null>(null);
  const [busy, setBusy] = useState(0);
  const conversations = useData((s) => s.conversations);
  const load = useCallback(() => call(client.GET("/api/feed")).then((r) => setFeed(r.items), () => setFeed(null)), []);
  useEffect(() => void load(), [load]);
  useLive(() => void load());
  useEffect(() => void data.loadConversations().catch(() => {}), []);

  const act = async (id: number, run: () => Promise<unknown>) => {
    setBusy(id);
    try {
      await run();
      await load();
    } catch (err) {
      fail(humanError(err));
    } finally {
      setBusy(0);
    }
  };
  const title = (id: number) => conversations?.find((c) => c.id === id)?.title ?? "";
  const shown = (feed ?? []).filter((i) => i.state !== "pending" && !(i.snoozed_until && i.snoozed_until > Date.now()));
  if (!shown.length) return null;
  return (
    <section id="feed-items" className="mb-8 flex flex-col gap-8" aria-label="Agent work">
      {shown.map((i) => {
        const next = (feed ?? []).filter((n) => n.state === "pending" && n.agent_id === i.agent_id && n.conversation_id === i.conversation_id);
        const accept = i.state === "blocking" && i.can_accept;
        return (
          <ItemFrame
            key={i.id}
            dataId={i.id}
            kind={i.state === "blocking" ? "blocking" : i.state === "fyi" ? "done" : "started"}
            title={i.title}
            context={[i.recommendation && `Recommended: ${i.recommendation}`, i.context, next.length && `Next: ${next.map((n) => n.title).join(", ")}`].filter(Boolean).join(" · ")}
            from={{ id: i.conversation_id, title: title(i.conversation_id) }}
            busy={busy === i.id}
            actions={
              accept ? (
                <Button variant="primary" disabled={busy === i.id} onClick={() => void act(i.id, () => call(client.POST("/api/feed/{id}/accept", { params: { path: { id: i.id } }, body: { if_version: i.version } })))}>
                  Accept
                </Button>
              ) : i.state === "fyi" ? (
                <Button disabled={busy === i.id} onClick={() => void act(i.id, () => call(client.POST("/api/feed/{id}/ack", { params: { path: { id: i.id } } })))}>
                  Got it
                </Button>
              ) : null
            }
          />
        );
      })}
    </section>
  );
}
