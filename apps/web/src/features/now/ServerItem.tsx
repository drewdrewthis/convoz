import type { FeedItem } from "@convoz/api-client";
import { Button } from "@convoz/ui/Button";
import { useState, type FormEvent } from "react";
import { FeedThread } from "./DevFeedThread.tsx";
import { ItemFrame } from "./DevFrame.tsx";
import { laterOptionsAt } from "./presets.ts";
import type { useServerFeed } from "./serverFeed.ts";

type Feed = ReturnType<typeof useServerFeed>;

/** AddInfo is the small form under a blocking item: the owner's words go to the agent through the item (POST answer). */
function AddInfo({ send, busy }: { send: (text: string) => void; busy: boolean }) {
  const [text, setText] = useState("");
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (text.trim()) send(text.trim());
  };
  return (
    <form className="flex items-center gap-8" onSubmit={submit}>
      {/* eslint-disable-next-line convoz/no-raw-input -- a pill with no visible label (aria-label); Field draws a label above its input */}
      <input aria-label="Add info" type="text" autoFocus value={text} maxLength={2000} onChange={(e) => setText(e.target.value)} className="h-52 w-full min-w-0 flex-auto rounded-full border border-solid border-edge bg-raised px-16 text-16 text-text [font-family:inherit]" />
      <Button variant="primary" size="inline" type="submit" disabled={busy || !text.trim()}>
        Send
      </Button>
    </form>
  );
}

/** ServerItem is one item the server keeps (GET /api/feed) in the frame. Blocking: Accept (when the agent recommends something), Add info, Snooze. Started and fyi: Got it (fyi only) and Snooze. */
export function ServerItem({ item, next, feed, from, skew }: { item: FeedItem; next: string[]; feed: Feed; from: string; skew: number }) {
  const [adding, setAdding] = useState(false);
  const busy = feed.busy === item.id;
  const options = laterOptionsAt(Date.now() + skew);
  const blocking = item.state === "blocking";
  return (
    <ItemFrame
      kind={blocking ? "blocking" : item.state === "started" ? "started" : "done"}
      dataId={item.id}
      title={item.title}
      context={[item.recommendation && `Recommended: ${item.recommendation}`, item.context].filter(Boolean).join(". ")}
      next={next}
      from={{ id: item.conversation_id, title: from }}
      busy={busy}
      thread={
        item.thread_root_id || adding ? (
          <>
            {item.thread_root_id ? <FeedThread conversation={item.conversation_id} root={item.thread_root_id} direct /> : null}
            {adding ? <AddInfo busy={busy} send={(t) => void feed.answer(item, t).then(() => setAdding(false))} /> : null}
          </>
        ) : undefined
      }
      snooze={{ presets: options.map((o) => ({ key: o.label, label: o.label })), pick: (k) => void feed.snooze(item, options.find((o) => o.label === k)?.until ?? 0) }}
      actions={
        <>
          {blocking && item.can_accept ? (
            <Button variant="primary" size="inline" className="mr-8 ml-8" disabled={busy} onClick={() => void feed.accept(item)}>
              Accept
            </Button>
          ) : null}
          {blocking ? (
            <Button variant="text" size="inline" onClick={() => setAdding((a) => !a)}>
              Add info
            </Button>
          ) : null}
          {item.state === "fyi" ? (
            <Button variant="primary" size="inline" className="mr-8 ml-8" disabled={busy} onClick={() => void feed.ack(item)}>
              Got it
            </Button>
          ) : null}
        </>
      }
    />
  );
}
