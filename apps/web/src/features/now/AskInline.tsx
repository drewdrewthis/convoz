import type { Ask, Message } from "@convoz/api-client";
import { AskCard, type Answer } from "@convoz/app-kit";
import { useState, type ReactNode } from "react";
import { data, useData } from "../../shared/data.ts";
import { humanError } from "../../shared/api.ts";
import { useNotice } from "../../shared/notice.tsx";
import { pinMessage, toast, unpinMessage } from "../pins-stars/index.ts";
import { AskApp } from "./AskApp.tsx";
import { presetsAt } from "./presets.ts";
import { answerAsk, dismissAsk, snoozeAsk, undismissAsk, useNow } from "./store.ts";

// The thread pane (and the composer it holds) is loaded the same way, by the Reply that opens it.
const openThread = (conversation: number, root: number) => import("../threads/index.ts").then((f) => f.useThreads.getState().openThread(conversation, root));

/** AskInline is the ask card inside a conversation. Its changes go to the same routes as Now's, and the message that holds the ask
 *  takes the new state at once (the stream frame brings the same state a moment later). */
// deleteSheet comes from the conversation feature (which owns message deletion), so this feature does not import it.
export function AskInline({ ask, labelId, inThread = false, deleteSheet }: { ask: Ask; labelId: string; inThread?: boolean; deleteSheet?: (close: () => void) => ReactNode }) {
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
      onReply={inThread ? undefined : () => void openThread(ask.conversation_id, ask.thread_root_id ?? ask.id)}
      pinned={pinned}
      onPin={() => void (pinned ? unpinMessage : pinMessage)(ask.conversation_id, ask.id).catch((err) => toast(humanError(err)))}
      onDelete={() => setDeleting(true)}
      onCopyLink={() => void navigator.clipboard?.writeText(`${location.origin}/chats/${ask.conversation_id}#m${ask.id}`)}
    />
    {deleting && deleteSheet ? deleteSheet(() => setDeleting(false)) : null}
    <AskApp ask={ask} />
    </>
  );
}
