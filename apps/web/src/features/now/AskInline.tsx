import type { Ask } from "@convoz/api-client";
import { AskCard, type Answer } from "@convoz/app-kit";
import { useState } from "react";
import { AppHost } from "../apps-host/index.ts";
import { data } from "../../shared/data.ts";
import { humanError } from "../../shared/api.ts";
import { useNotice } from "../../shared/notice.tsx";
import { presetsAt } from "./presets.ts";
import { answerAsk, dismissAsk, snoozeAsk, undismissAsk, useNow } from "./store.ts";

/** AskInline is the ask card inside a conversation. Its changes go to the same routes as Now's, and the message that holds the ask
 *  takes the new state at once (the stream frame brings the same state a moment later). */
export function AskInline({ ask, labelId }: { ask: Ask; labelId: string }) {
  const { fail } = useNotice();
  const skew = useNow((s) => s.skew);
  const [busy, setBusy] = useState(false);
  const run = async (change: () => Promise<{ ask: Ask }>) => {
    if (busy) return;
    setBusy(true);
    try {
      const { ask: next } = await change();
      data.store.setState((s) => {
        const held = s.messages[next.conversation_id];
        if (!held) return s;
        return { messages: { ...s.messages, [next.conversation_id]: { ...held, list: held.list.map((m) => (m.id === next.id ? { ...m, ask: next } : m)) } } };
      });
    } catch (err) {
      fail(humanError(err));
    } finally {
      setBusy(false);
    }
  };
  const answer = (a: Answer) => run(() => answerAsk(ask.id, { ...a, if_version: ask.version, via: "inline" }));
  return (
    <>
    <AskCard
      ask={ask}
      where="conversation"
      as="div"
      labelId={labelId}
      presets={presetsAt(Date.now() + skew)}
      busy={busy}
      onAnswer={(a) => void answer(a)}
      onDismiss={() => void run(() => dismissAsk(ask.id, ask.version))}
      onUndismiss={() => void run(() => undismissAsk(ask.id, ask.version))}
      onSnooze={(preset) => void run(() => snoozeAsk(ask.id, preset))}
    />
    {ask.app ? <AppHost app={ask.app} messageId={ask.id} agent={ask.asker} conversation={ask.conversation_id} threadRoot={ask.thread_root_id} onAsk /> : null}
    </>
  );
}
