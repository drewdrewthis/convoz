import type { Ask, NowWaiting } from "@convoz/api-client";
import { whoLine, type Answer, type SnoozePreset } from "@convoz/app-kit";
import { Button } from "@convoz/ui/Button";
import { useState } from "react";
import { visit } from "../../shared/navigate.ts";
import { toast } from "../pins-stars/index.ts";
import { FeedThread } from "./FeedThread.tsx";
import { entries } from "./entries.ts";
import { ItemFrame } from "./ItemFrame.tsx";
import { NowAsk } from "./NowAsk.tsx";
import { useNow } from "./store.ts";
import type { Fyi } from "./feed.ts";

interface NeedsYouProps {
  asks: Ask[];
  waiting: NowWaiting[];
  /** fyi items: plan steps started or done, and the owner's questions. */
  fyi: Fyi[];
  busy: ReadonlySet<number>;
  presets: SnoozePreset[];
  answer: (ask: Ask, a: Answer) => void;
  dismiss: (ask: Ask) => void;
  snooze: (ask: Ask, preset: string) => void;
  current: number;
  compact: boolean;
}

const clockOf = (at: number) => new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

/** AskItem is an open ask in the frame: Accept answers with the first (recommended) option; Add info opens its thread with the reply box in focus. */
function AskItem({ ask, busy, presets, answer, snooze }: { ask: Ask; busy: boolean; presets: SnoozePreset[]; answer: NeedsYouProps["answer"]; snooze: NeedsYouProps["snooze"] }) {
  const [request, setRequest] = useState(0);
  const root = ask.thread_root_id ?? ask.id;
  const why = ask.answers || ask.options[0]?.why || "";
  const recommended = ask.options[0]?.label;
  return (
    <ItemFrame
      kind="blocking"
      title={ask.question}
      context={[recommended ? `Recommended: ${recommended}` : "", why, `Asked by ${whoLine(ask.asker)}`].filter(Boolean).join(". ")}
      tag={ask.urgent ? "Urgent" : undefined}
      from={{ id: ask.conversation_id, title: ask.conversation?.title ?? "" }}
      thread={<FeedThread conversation={ask.conversation_id} root={root} count={ask.reply_count} request={request} onReplied={(ok) => (void useNow.getState().load().catch(() => {}), ok && toast("Replied. The ask moved to You replied."))} />}
      snooze={{ presets, pick: (k) => snooze(ask, k) }}
      busy={busy}
      dataId={ask.id}
      actions={
        <>
          <Button variant="primary" size="inline" className="mr-8 ml-8" disabled={busy} onClick={() => answer(ask, { choice: "recommended" })}>
            Accept
          </Button>
          <Button variant="text" size="inline" onClick={() => setRequest((n) => n + 1)}>
            Add info
          </Button>
        </>
      }
    />
  );
}

/** FyiItem is a piece of work started or done, or an answered question: the owner only needs to know. It has no action yet: Got it comes with the server's feed record. */
function FyiItem({ item: f }: { item: Fyi }) {
  return <ItemFrame kind={f.state} title={f.title} context={f.context} next={f.next} from={{ id: f.conversation_id, title: f.from }} />;
}

/** PlanItem is a plan step that waits on the owner. The server has no snooze for it and no thread of its own, so both buttons open the conversation for now. */
function PlanItem({ plan }: { plan: NowWaiting }) {
  const href = `/chats/${plan.conversation.id}`;
  return (
    <ItemFrame
      kind="blocking"
      title={plan.text}
      context={`${whoLine(plan.agent)} is waiting on you since ${clockOf(plan.since)}`}
      from={{ id: plan.conversation.id, title: plan.conversation.title ?? "" }}
      actions={
        <>
          <Button variant="primary" size="inline" className="mr-8 ml-8" href={href} onClick={(e) => visit(e, href)}>
            Accept
          </Button>
          <Button variant="text" size="inline" href={href} onClick={(e) => visit(e, href)}>
            Add info
          </Button>
        </>
      }
    />
  );
}

/** NeedsYou is the one list of Now: one frame for every item, blocking or fyi, newest first. An ask with a draft keeps the full ask card, whose Send carries the draft. */
export function NeedsYou({ asks, waiting, fyi, busy, presets, answer, dismiss, snooze, current, compact }: NeedsYouProps) {
  const list = entries(asks, waiting, fyi);
  if (!list.length) return null;
  return (
    <section id="asks" className="mb-8 flex flex-col gap-8">
      {list.map((e) =>
        "ask" in e ? (
          <div key={`a${e.ask.id}`} className="flex flex-col gap-8" data-conv={e.ask.conversation_id} aria-current={e.ask.conversation_id === current ? "page" : undefined}>
            {e.ask.draft ? (
              <NowAsk ask={e.ask} busy={busy.has(e.ask.id)} presets={presets} answer={answer} dismiss={dismiss} snooze={snooze} compact={compact} />
            ) : (
              <AskItem ask={e.ask} busy={busy.has(e.ask.id)} presets={presets} answer={answer} snooze={snooze} />
            )}
          </div>
        ) : "fyi" in e ? (
          <div key={`f${e.fyi.key}`} aria-current={e.fyi.conversation_id === current ? "page" : undefined}>
            <FyiItem item={e.fyi} />
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
