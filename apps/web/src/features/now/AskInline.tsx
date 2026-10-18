import type { Ask, Message } from "@convoz/api-client";
import { AskCard, type Answer } from "@convoz/app-kit";
import { useState } from "react";
import { AppHost } from "../apps-host/index.ts";
import { data, useData } from "../../shared/data.ts";
import { humanError } from "../../shared/api.ts";
import { useNotice } from "../../shared/notice.tsx";
import { DeleteSheet } from "../conversations/messages/MessageMenu.tsx";
import { pinMessage, toast, unpinMessage } from "../pins-stars/index.ts";
import { useThreads } from "../threads/index.ts";
import { presetsAt } from "./presets.ts";
import { answerAsk, dismissAsk, snoozeAsk, undismissAsk, useNow } from "./store.ts";

/** AskInline is the ask card inside a conversation. Its changes go to the same routes as Now's, and the message that holds the ask
 *  takes the new state at once (the stream frame brings the same state a moment later). */
export function AskInline({ ask, labelId, inThread = false }: { ask: Ask; labelId: string; inThread?: boolean }) {
  const { fail } = useNotice();
  const skew = useNow((s) => s.skew);
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const pinned = useData((s) => Boolean(s.rows[ask.conversation_id]?.pinned?.some((x) => x.id === ask.id)));
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
      onReply={inThread ? undefined : () => void useThreads.getState().openThread(ask.conversation_id, ask.thread_root_id ?? ask.id)}
      pinned={pinned}
      onPin={() => void (pinned ? unpinMessage : pinMessage)(ask.conversation_id, ask.id).catch((err) => toast(humanError(err)))}
      onDelete={() => setDeleting(true)}
      onCopyLink={() => void navigator.clipboard?.writeText(`${location.origin}/chats/${ask.conversation_id}#m${ask.id}`)}
    />
    {deleting ? <DeleteSheet message={{ id: ask.id } as Message} close={() => setDeleting(false)} /> : null}
    {ask.app ? <AppHost app={ask.app} messageId={ask.id} agent={ask.asker} conversation={ask.conversation_id} threadRoot={ask.thread_root_id} onAsk /> : null}
    </>
  );
}
