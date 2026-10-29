import type { FeedItem } from "@convoz/api-client";
import { Button } from "@convoz/ui/Button";
import { useState } from "react";
import { FeedThread } from "./DevFeedThread.tsx";
import { ItemFrame } from "./DevFrame.tsx";
import { OkayGlyph, ReplyGlyph } from "./DevIcons.tsx";
import { ReplyBox } from "./DevReplyBox.tsx";
import { laterOptionsAt } from "./presets.ts";
import type { useServerFeed } from "./serverFeed.ts";

type Feed = ReturnType<typeof useServerFeed>;

/**
 * ServerItem is one item the server keeps (GET /api/feed) in the frame, with the three actions Okay, Reply and Snooze (owner, conv 179 msg 12251).
 * Okay is Accept on a blocking item that recommends something; on any other item it is the acknowledge (POST ack): the item leaves the feed until the agent moves it again.
 * Reply opens the item's thread with the box in focus; with no thread yet the box starts one (POST reply). It does not close the item.
 */
export function ServerItem({ item, next, feed, from, skew }: { item: FeedItem; next: string[]; feed: Feed; from: string; skew: number }) {
  const [request, setRequest] = useState(0);
  const busy = feed.busy === item.id;
  const options = laterOptionsAt(Date.now() + skew);
  const blocking = item.state === "blocking";
  const okay = () => (blocking && item.can_accept ? feed.accept(item) : feed.ack(item));
  return (
    <ItemFrame
      kind={blocking ? "blocking" : item.state === "started" ? "started" : "done"}
      dataId={item.id}
      at={item.updated_at}
      title={item.title}
      context={[item.recommendation && `Recommended: ${item.recommendation}`, item.context].filter(Boolean).join(". ")}
      next={next}
      from={{ id: item.conversation_id, title: from }}
      busy={busy}
      thread={item.thread_root_id ? <FeedThread conversation={item.conversation_id} root={item.thread_root_id} request={request} /> : <ReplyBox busy={busy} request={request} send={(t) => void feed.reply(item, t)} />}
      snooze={{ presets: options.map((o) => ({ key: o.label, label: o.label })), pick: (k) => void feed.snooze(item, options.find((o) => o.label === k)?.until ?? 0) }}
      actions={
        <>
          <Button variant="primary" size="inline" className="mr-8 ml-8" disabled={busy} onClick={() => void okay()}>
            <OkayGlyph />
            Okay
          </Button>
          <Button variant="text" size="inline" onClick={() => setRequest((n) => n + 1)}>
            <ReplyGlyph />
            Reply
          </Button>
        </>
      }
    />
  );
}
