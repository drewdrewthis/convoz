import type { Ask } from "@convoz/api-client";
import { AskCard, type Answer } from "@convoz/app-kit";
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
}

/** NowAsk is one open ask of the feed: its card, the app an agent attached to it, and what the agents are doing about the owner's last message. */
export function NowAsk({ ask, busy, presets, answer, dismiss, snooze }: NowAskProps) {
  const id = useId();
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
        onReply={() => navigate(`/chats/${ask.conversation_id}#reply=${ask.thread_root_id ?? ask.id}`)}
      />
      <AskApp ask={ask} />
      <Attention conversation={ask.conversation_id} />
    </>
  );
}
