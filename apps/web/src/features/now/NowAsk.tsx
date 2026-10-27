import type { Ask } from "@convoz/api-client";
import { AskCard, type Answer } from "@convoz/app-kit";
import { useId } from "react";
import { navigate } from "../../shared/navigate.ts";
import { toast } from "../pins-stars/index.ts";
import { AskApp } from "./AskApp.tsx";
import { Attention } from "./Attention.tsx";
import { FeedThread } from "./FeedThread.tsx";
import { useNow } from "./store.ts";

/** repliedInThread runs when a reply typed in an ask's thread was taken: the server moved the ask to You replied, so Now reads again. A lost reply reads again too, to show the truth. */
function repliedInThread(ok: boolean): void {
  void useNow.getState().load().catch(() => {});
  if (ok) toast("Replied. The ask moved to You replied.");
}

interface NowAskProps {
  ask: Ask;
  busy: boolean;
  presets: { key: string; label: string }[];
  answer: (ask: Ask, a: Answer) => void;
  dismiss: (ask: Ask) => void;
  snooze: (ask: Ask, preset: string) => void;
  /** The sidebar's short card (owner, conv 179 msg 6018): the same AskCard, drawn short: the question, the recommended answer, Open conversation and Dismiss. An ask with a draft keeps the full card, whose Send carries the draft. */
  compact?: boolean;
}

/** NowAsk is one open ask of the feed: its card, the app an agent attached to it, and what the agents are doing about the owner's last message. */
export function NowAsk({ ask, busy, presets, answer, dismiss, snooze, compact = false }: NowAskProps) {
  const id = useId();
  const thread = <FeedThread conversation={ask.conversation_id} root={ask.thread_root_id ?? ask.id} count={ask.reply_count} onReplied={repliedInThread} />;
  const short = compact && !ask.draft;
  return (
    <>
      <AskCard
        ask={ask}
        where="now"
        labelId={id}
        presets={presets}
        busy={busy}
        dataId={ask.id}
        openHref={`/chats/${ask.conversation_id}`}
        onAnswer={(a) => answer(ask, a)}
        onDismiss={() => dismiss(ask)}
        onUndismiss={() => undefined}
        onSnooze={(preset) => snooze(ask, preset)}
        replies={{ count: ask.reply_count, unread: ask.unread_replies }}
        footer={thread}
        compact={short}
        onReply={short ? undefined : () => navigate(`/chats/${ask.conversation_id}#reply=${ask.thread_root_id ?? ask.id}`)}
      />
      {short ? null : (
        <>
          <AskApp ask={ask} />
          <Attention conversation={ask.conversation_id} />
        </>
      )}
    </>
  );
}
