import type { Ask } from "@convoz/api-client";
import { AskCard, type Answer } from "@convoz/app-kit";
import { Button } from "@convoz/ui/Button";
import { useId, type ReactNode } from "react";
import { navigate } from "../../shared/navigate.ts";
import { AskApp } from "./AskApp.tsx";
import { Attention } from "./Attention.tsx";
import { FeedThread } from "./FeedThread.tsx";

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
function CompactAsk({ ask, busy, answer, thread }: Pick<NowAskProps, "ask" | "busy" | "answer"> & { thread: ReactNode }) {
  const id = useId();
  const first = ask.options[0];
  const p = ask.permission;
  if (p) {
    const href = `/chats/${ask.conversation_id}`;
    return (
      <article className="flex min-w-0 flex-col gap-8 rounded-[14px] border border-solid border-border bg-raised px-14 pt-12 pb-8" aria-labelledby={id} tabIndex={-1} data-ask={ask.id}>
        <p className="m-0 text-13 text-muted">{`@${ask.asker.handle} · ${new Date(ask.created_at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`}</p>
        <dl className="m-0 text-13 leading-[18px] text-muted">
          <dt className="font-semibold text-text">I will</dt>
          <dd id={id} className="m-0 text-15 leading-[20px] font-semibold text-text [overflow-wrap:anywhere]">
            {p.action}
          </dd>
          <dt className="mt-4 font-semibold text-text">Risk</dt>
          <dd className="m-0 text-text [overflow-wrap:anywhere]">{p.risk}</dd>
          <dt className="mt-4 font-semibold text-text">Undo</dt>
          <dd className={p.one_way ? "m-0 font-semibold text-danger" : "m-0 text-text [overflow-wrap:anywhere]"}>{p.one_way ? "None. This is one-way." : p.undo}</dd>
        </dl>
        {thread}
        {p.one_way ? (
          <Button size="option" href={href}>
            Review
          </Button>
        ) : (
          <>
            <Button size="option" variant="primary" disabled={busy} onClick={() => answer(ask, { choice: "recommended" })}>
              Go
            </Button>
            <Button variant="text" size="inline" className="-ml-8 self-start" href={href}>
              Open
            </Button>
          </>
        )}
      </article>
    );
  }
  return (
    <article className="flex min-w-0 flex-col gap-8 rounded-[14px] border border-solid border-border bg-raised px-14 pt-12 pb-8" aria-labelledby={id} tabIndex={-1} data-ask={ask.id}>
      <h3 id={id} className="m-0 text-15 leading-[20px] font-semibold [overflow-wrap:anywhere]">
        {ask.question}
      </h3>
      {thread}
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
  const thread = <FeedThread conversation={ask.conversation_id} root={ask.thread_root_id ?? ask.id} count={ask.reply_count} />;
  if (compact && !ask.draft) return <CompactAsk ask={ask} busy={busy} answer={answer} thread={thread} />;
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
        onReply={() => navigate(`/chats/${ask.conversation_id}#reply=${ask.thread_root_id ?? ask.id}`)}
      />
      <AskApp ask={ask} />
      <Attention conversation={ask.conversation_id} />
    </>
  );
}
