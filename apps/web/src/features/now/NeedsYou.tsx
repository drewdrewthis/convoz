import type { Ask, FeedItem, NowWaiting } from "@convoz/api-client";
import { whoLine, type Answer, type SnoozePreset } from "@convoz/app-kit";
import { Button } from "@convoz/ui/Button";
import { useState } from "react";
import { humanError } from "../../shared/api.ts";
import { newId } from "../../shared/chat.ts";
import { source } from "../../shared/data.ts";
import { visit } from "../../shared/navigate.ts";
import { useNotice } from "../../shared/notice.tsx";
import { toast } from "../pins-stars/index.ts";
import { FeedThread } from "./DevFeedThread.tsx";
import { AskApp } from "./AskApp.tsx";
import { laterOptionsAt } from "./presets.ts";
import { useSeen } from "./seen.ts";
import { askFrame, carriesApp, okayAnswer } from "./askView.ts";
import { entries, nextOf } from "./entries.ts";
import { ItemFrame } from "./DevFrame.tsx";
import { OkayGlyph, ReplyGlyph } from "./DevIcons.tsx";
import { ReplyBox } from "./DevReplyBox.tsx";
import { planReply } from "./planReply.ts";
import { useNow } from "./store.ts";
import { ServerItem } from "./ServerItem.tsx";
import type { useServerFeed } from "./serverFeed.ts";
import type { Fyi } from "./feed.ts";

interface NeedsYouProps {
  asks: Ask[];
  waiting: NowWaiting[];
  /** fyi items: plan steps started or done, and the owner's questions. */
  fyi: Fyi[];
  /** The items the server keeps, already filtered to cards. */
  server: { shown: FeedItem[]; all: readonly FeedItem[]; feed: ReturnType<typeof useServerFeed>; titles: (id: number) => string; skew: number };
  busy: ReadonlySet<number>;
  presets: SnoozePreset[];
  answer: (ask: Ask, a: Answer) => void;
  dismiss: (ask: Ask) => void;
  snooze: (ask: Ask, preset: string) => void;
  current: number;
  compact: boolean;
}

const clockOf = (at: number) => new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

/** AskItem is an open ask in the frame: Okay answers with the first (recommended) option; Reply opens its thread with the reply box in focus. */
function AskItem({ ask, busy, presets, answer, snooze }: { ask: Ask; busy: boolean; presets: SnoozePreset[]; answer: NeedsYouProps["answer"]; snooze: NeedsYouProps["snooze"] }) {
  const [request, setRequest] = useState(0);
  const root = ask.thread_root_id ?? ask.id;
  const { title, context } = askFrame(ask, whoLine(ask.asker));
  return (
    <ItemFrame
      kind="blocking"
      title={title}
      context={context}
      app={carriesApp(ask) ? <AskApp ask={ask} /> : undefined}
      tag={ask.urgent ? "Urgent" : undefined}
      from={{ id: ask.conversation_id, title: ask.conversation?.title ?? "" }}
      thread={
        <FeedThread
          conversation={ask.conversation_id}
          root={root}
          count={ask.reply_count}
          request={request}
          onReplied={(ok) => (
            void useNow
              .getState()
              .load()
              .catch(() => {}),
            ok && toast("Replied. The ask moved to You replied.")
          )}
        />
      }
      snooze={{ presets, pick: (k) => snooze(ask, k) }}
      busy={busy}
      dataId={ask.id}
      at={ask.created_at}
      link={{ message: ask.id }}
      actions={
        <>
          <Button variant="primary" size="inline" className="mr-8 ml-8" disabled={busy} onClick={() => answer(ask, okayAnswer(ask))}>
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

/** FyiItem is a piece of work started or done, or an answered question: the owner only needs to know. Okay and Snooze are seen marks kept on the device (seen.ts), since no server row stands behind the card; Reply opens its thread when it has one. */
function FyiItem({ item: f, presets }: { item: Fyi; presets: { key: string; label: string; until: number }[] }) {
  const [request, setRequest] = useState(0);
  const { okay, snooze } = useSeen.getState();
  return (
    <ItemFrame
      kind={f.state}
      at={f.at}
      title={f.title}
      context={f.context}
      next={f.next}
      link={{ message: f.root ?? undefined }}
      from={{ id: f.conversation_id, title: f.from }}
      thread={f.root ? <FeedThread conversation={f.conversation_id} root={f.root} request={request} /> : undefined}
      snooze={{ presets, pick: (k) => snooze(f, presets.find((p) => p.key === k)?.until ?? 0) }}
      actions={
        <>
          <Button variant="primary" size="inline" className="mr-8 ml-8" onClick={() => okay(f)}>
            <OkayGlyph />
            Okay
          </Button>
          {f.root ? (
            <Button variant="text" size="inline" onClick={() => setRequest((n) => n + 1)}>
              <ReplyGlyph />
              Reply
            </Button>
          ) : null}
        </>
      }
    />
  );
}

/**
 * PlanItem is a plan step that waits on the owner. The server has no snooze for it and no thread of its own, so Okay opens the
 * conversation for now; Reply opens a box in place whose text goes to the conversation, naming the agent (planReply).
 */
function PlanItem({ plan }: { plan: NowWaiting }) {
  const href = `/chats/${plan.conversation.id}`;
  const [request, setRequest] = useState(0);
  const [busy, setBusy] = useState(false);
  const { fail } = useNotice();
  const send = (text: string) => {
    const out = planReply(plan, text);
    if (!out) return;
    setBusy(true);
    source
      .post(out.conversation, newId(), out.body)
      .then(() => toast(`Sent to @${plan.agent.handle}`), (err: unknown) => fail(humanError(err)))
      .finally(() => setBusy(false));
  };
  return (
    <ItemFrame
      kind="blocking"
      at={plan.since}
      title={plan.text}
      context={`${whoLine(plan.agent)} is waiting on you since ${clockOf(plan.since)}`}
      from={{ id: plan.conversation.id, title: plan.conversation.title ?? "" }}
      thread={<ReplyBox busy={busy} request={request} send={send} />}
      actions={
        <>
          <Button variant="primary" size="inline" className="mr-8 ml-8" href={href} onClick={(e) => visit(e, href)}>
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

/** NeedsYou is the one list of Now: one frame for every item, blocking or fyi, newest first. An ask with a draft keeps the full ask card, whose Send carries the draft. */
export function NeedsYou({ asks, waiting, fyi, server, busy, presets, answer, snooze, current }: NeedsYouProps) {
  const list = entries(asks, waiting, fyi, server.shown);
  if (!list.length) return null;
  return (
    <section id="asks" className="mb-8 flex flex-col gap-8">
      {list.map((e) =>
        "ask" in e ? (
          <div key={`a${e.ask.id}`} className="flex flex-col gap-8" data-conv={e.ask.conversation_id} aria-current={e.ask.conversation_id === current ? "page" : undefined}>
            <AskItem ask={e.ask} busy={busy.has(e.ask.id)} presets={presets} answer={answer} snooze={snooze} />
          </div>
        ) : "item" in e ? (
          <div key={`i${e.item.id}`} data-conv={e.item.conversation_id} aria-current={e.item.conversation_id === current ? "page" : undefined}>
            <ServerItem item={e.item} next={nextOf(server.all, e.item)} feed={server.feed} from={server.titles(e.item.conversation_id)} skew={server.skew} />
          </div>
        ) : "fyi" in e ? (
          <div key={`f${e.fyi.key}`} aria-current={e.fyi.conversation_id === current ? "page" : undefined}>
            <FyiItem item={e.fyi} presets={laterOptionsAt(Date.now() + server.skew).map((o) => ({ key: o.label, label: o.label, until: o.until }))} />
          </div>
        ) : (
          <div key={`p${e.plan.conversation.id}-${e.plan.text}`} data-conv={e.plan.conversation.id} aria-current={e.plan.conversation.id === current ? "page" : undefined}>
            <PlanItem plan={e.plan} />
          </div>
        ),
      )}
    </section>
  );
}
