import type { Ask } from "@convoz/api-client";
import { AskCard, type Answer } from "@convoz/app-kit";
import { useState, type ReactNode } from "react";
import { data, useData } from "../../shared/data.ts";
import { humanError } from "../../shared/api.ts";
import { useNotice } from "../../shared/notice.tsx";
import { pinMessage, toast, unpinMessage } from "../pins-stars/index.ts";
import { DEV } from "../../shared/base.ts";
import { AskApp } from "./AskApp.tsx";
import { DevAskItem } from "./DevAskItem.tsx";
import { okayAnswer } from "./askView.ts";
import { useThreads } from "../threads/index.ts";
import { presetsAt } from "./presets.ts";
import { answerAsk, dismissAsk, snoozeAsk, undismissAsk, useNow } from "./store.ts";

// "I have questions" opens the reply box of the ask's thread, under the ask in the conversation.
const replyInThread = (conversation: number, root: number) => useThreads.getState().startReply(conversation, root);

/** AskInline is the ask card inside a conversation. Its changes go to the same routes as Now's, and the message that holds the ask
 *  takes the new state at once (the stream frame brings the same state a moment later). */
// deleteSheet comes from the conversation feature (which owns message deletion), so this feature does not import it.
export function AskInline({ ask, labelId, deleteSheet, replies }: { ask: Ask; labelId: string; deleteSheet?: (close: () => void) => ReactNode; replies?: { count?: number; unread?: number } }) {
  const { fail } = useNotice();
  const skew = useNow((s) => s.skew);
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const pinned = useData((s) => Boolean(s.rows[ask.conversation_id]?.pinned?.some((x) => x.id === ask.id)));
  const run = async (change: () => Promise<{ ask: Ask; lost?: boolean }>) => {
    if (busy) return;
    setBusy(true);
    try {
      const { ask: next, lost } = await change();
      if (lost) fail(`The ask is ${next.state} now. Nothing was changed.`); // never a click that does nothing (msg 1802)
      data.store.setState((s) => {
        const held = s.messages[next.conversation_id];
        if (!held) return s;
        return { messages: { ...s.messages, [next.conversation_id]: { ...held, list: held.list.map((m) => (m.id === next.id ? { ...m, ask: next } : m)) } } };
      });
      // An ask inside a thread is drawn from the threads store, not the main list: its copy there takes the new state too.
      const root = next.thread_root_id;
      const reply = root ? useThreads.getState().threads[root]?.replies.find((m) => m.id === next.id) : undefined;
      if (reply) useThreads.getState().received({ ...reply, ask: next }, next.conversation_id);
    } catch (err) {
      fail(humanError(err));
    } finally {
      setBusy(false);
    }
  };
  const answer = (a: Answer) => run(() => answerAsk(ask.id, { ...a, if_version: ask.version, via: "inline" }));
  const rep = replies ?? { count: ask.reply_count, unread: ask.unread_replies };
  const copy = () => void navigator.clipboard?.writeText(`${location.origin}/chats/${ask.conversation_id}#m${ask.id}`);
  if (DEV) {
    const menu = [
      { label: pinned ? "Unpin" : "Pin", run: () => void (pinned ? unpinMessage : pinMessage)(ask.conversation_id, ask.id).catch((err) => toast(humanError(err))) },
      { label: "Copy link", run: copy },
      { label: "Delete", run: () => setDeleting(true) },
    ];
    return (
      <>
        <DevAskItem ask={ask} busy={busy} presets={presetsAt(Date.now() + skew)} okay={() => void answer(okayAnswer(ask))} reply={() => replyInThread(ask.conversation_id, ask.thread_root_id ?? ask.id)} snooze={(k) => void run(() => snoozeAsk(ask.id, k))} menu={menu} replies={rep} />
        {deleting && deleteSheet ? deleteSheet(() => setDeleting(false)) : null}
      </>
    );
  }
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
      replies={rep}
      onReply={() => replyInThread(ask.conversation_id, ask.thread_root_id ?? ask.id)}
      pinned={pinned}
      onPin={() => void (pinned ? unpinMessage : pinMessage)(ask.conversation_id, ask.id).catch((err) => toast(humanError(err)))}
      onDelete={() => setDeleting(true)}
      onCopyLink={copy}
    />
    {deleting && deleteSheet ? deleteSheet(() => setDeleting(false)) : null}
    <AskApp ask={ask} />
    </>
  );
}
