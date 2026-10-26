import type { Ask } from "@convoz/api-client";
import { AskCard, type Answer } from "@convoz/app-kit";
import { Button } from "@convoz/ui/Button";
import { useId } from "react";
import { navigate } from "../../shared/navigate.ts";
import { AskApp } from "./AskApp.tsx";
import { Attention } from "./Attention.tsx";

interface NowAskProps {
  ask: Ask;
  busy: boolean;
  presets: { key: string; label: string }[];
  answer: (ask: Ask, a: Answer) => void;
  dismiss: (ask: Ask) => void;
  snooze: (ask: Ask, preset: string) => void;
  /** The sidebar's short card (owner, conv 179 msg 6018): the question, the recommended answer and Open. An ask with a draft keeps the full card, whose Send carries the draft. */
  compact?: boolean;
}

/** CompactAsk is the sidebar's ask card: the question, one tap for the recommended answer, and Open for everything else. */
function CompactAsk({ ask, busy, answer }: Pick<NowAskProps, "ask" | "busy" | "answer">) {
  const id = useId();
  const first = ask.options[0];
  return (
    <article className="flex min-w-0 flex-col gap-8 rounded-[14px] border border-solid border-border bg-raised px-14 pt-12 pb-8" aria-labelledby={id} tabIndex={-1} data-ask={ask.id}>
      <h3 id={id} className="m-0 text-15 leading-[20px] font-semibold [overflow-wrap:anywhere]">
        {ask.question}
      </h3>
      {first ? (
        <Button size="option" variant="primary" disabled={busy} onClick={() => answer(ask, { choice: "recommended" })}>
          {first.label}
        </Button>
      ) : null}
      <Button variant="text" size="inline" className="-ml-8 self-start" href={`/chats/${ask.conversation_id}`}>
        Open
      </Button>
    </article>
  );
}

/** NowAsk is one open ask of the feed: its card, the app an agent attached to it, and what the agents are doing about the owner's last message. */
export function NowAsk({ ask, busy, presets, answer, dismiss, snooze, compact = false }: NowAskProps) {
  const id = useId();
  if (compact && !ask.draft) return <CompactAsk ask={ask} busy={busy} answer={answer} />;
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
        onReply={() => navigate(`/chats/${ask.conversation_id}#reply=${ask.thread_root_id ?? ask.id}`)}
      />
      <AskApp ask={ask} />
      <Attention conversation={ask.conversation_id} />
    </>
  );
}
