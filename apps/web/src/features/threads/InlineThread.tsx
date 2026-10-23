import { Button } from "@convoz/ui/Button";
import { IconButton } from "@convoz/ui/IconButton";
import { AttachIcon, MicIcon, ReplyIcon, SendIcon } from "@convoz/ui/icons";
import type { Message } from "@convoz/api-client";
import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import { stripCf } from "../../shared/chat.ts";
import { useData } from "../../shared/data.ts";
import { replyingNote, useReplying } from "../../shared/presence.ts";
import { AttachmentList, MentionMenu, keepFocus, pasteFiles, useAttachments, useFileDrop, useMentionMenu } from "../composer/index.ts";
import { useVoiceNote } from "../voice/index.ts";
import { useThreads, type PendingReply } from "./store.ts";

/** A folded thread shows its first replies, each cut to one line (owner, conv 112: "show at least three lines when collapsed"). */
const FOLDED_REPLIES = 3;
const NONE: Message[] = [];
const NO_PENDING: PendingReply[] = [];

/**
 * useNewReplies is how many replies of a thread root are new to the viewer: the server's count, 0 once the viewer has read the thread
 * here (reading it moves readThrough at once; the server's count follows with the next frame). A server that sends only the flag
 * on last_reply gives 1.
 */
export function useNewReplies(message: Pick<Message, "id" | "reply_count" | "last_reply" | "unread_replies"> | undefined): number {
  const readThrough = useThreads((s) => s.readThrough[message?.id ?? 0] ?? 0);
  const last = message?.last_reply;
  if (!message?.reply_count || !last?.unread || last.id <= readThrough) return 0;
  return Math.max(1, message.unread_replies ?? 1);
}


export interface InlineThreadProps {
  root: Message;
  conversation: number;
  /** The newest root with a thread: its thread is unfolded unless the owner folded it. */
  latest: boolean;
  /** The replies drawn the way the main list draws messages (the conversation page owns that look). */
  bubbles(list: Message[], pending: PendingReply[]): ReactNode;
}

/**
 * InlineThread is the thread of one message, drawn under it in the conversation (owner, conv 112, issue 61: "if there's a reply/thread,
 * it should still be visible in the main conversation"). The latest thread shows every reply; an older one is folded to its first
 * replies with "Show all N replies". "Reply" opens a small reply box in place. It draws nothing for a message with no replies and no
 * open reply box.
 */
export function InlineThread({ root, conversation, latest, bubbles }: InlineThreadProps) {
  const id = root.id;
  const view = useThreads((s) => s.threads[id]);
  const replying = useThreads((s) => s.replying === id);
  const chosen = useThreads((s) => s.unfolded[id]);
  const fresh = useNewReplies(root);
  const count = root.reply_count ?? 0;
  const replies = view?.replies ?? NONE;
  const loaded = view?.loaded ?? false;
  const unfolded = chosen ?? latest;
  const top = replies.at(-1)?.id ?? 0;
  const note = replyingNote(useReplying(conversation, id));

  const hasReplies = count > 0;
  useEffect(() => {
    if (hasReplies) void useThreads.getState().load(conversation, id).catch(() => {});
  }, [conversation, id, hasReplies]);
  // A thread shown in full is read, like the main list on screen; a folded one stays unread until it is unfolded.
  useEffect(() => {
    if (unfolded && loaded) void useThreads.getState().markRead(id);
  }, [unfolded, loaded, top, id]);

  const total = Math.max(count, replies.length);
  if (!total && !replying && !view?.pending.length) return null;
  const shown = unfolded ? replies : replies.slice(0, FOLDED_REPLIES);
  const words = stripCf(root.body).replace(/\s+/g, " ").trim().slice(0, 60) || `a message by @${root.author.handle}`;
  const { setUnfolded, startReply } = useThreads.getState();
  const toggle = !unfolded ? (
    <Button variant="quiet" size="inline" className="ithmore" aria-expanded={false} onClick={() => setUnfolded(id, true)}>
      {total === 1 ? "Show the whole reply" : `Show all ${total} replies`}
      {fresh > 0 ? <b className="ithnew">{` · ${fresh} new`}</b> : null}
    </Button>
  ) : chosen && !latest && total > FOLDED_REPLIES ? (
    <Button variant="quiet" size="inline" className="ithmore" aria-expanded={true} onClick={() => setUnfolded(id, false)}>
      Show fewer replies
    </Button>
  ) : null;
  const parts = (
    <>
      {bubbles(shown, unfolded ? (view?.pending ?? NO_PENDING) : NO_PENDING)}
      <div className="working ithworking" role="status" hidden={!note}>
        {note ?? ""}
      </div>
    </>
  );
  const label = `Thread: ${words}`;
  if (replying) return <ReplyingThread rootId={id} conversation={conversation} label={label} parts={parts} toggle={toggle} />;
  return (
    <section className={`ithread${unfolded ? "" : " folded"}`} aria-label={label}>
      <div className="ithbody">
        {parts}
        <div className="ithbar">
          {toggle}
          <Button variant="text" size="inline" className="ithreply" aria-label="Reply in thread" onClick={() => startReply(conversation, id)}>
            <ReplyIcon />
            <span aria-hidden="true">Reply</span>
          </Button>
        </div>
      </div>
    </section>
  );
}

/** The thread with its reply box open: files dropped on it attach to the reply, "@" lists the agents as in the main chat, and Escape closes the box (or the open "@" menu). */
function ReplyingThread({ rootId, conversation, label, parts, toggle }: { rootId: number; conversation: number; label: string; parts: ReactNode; toggle: ReactNode }) {
  const { reply, stopReply } = useThreads.getState();
  const [text, setText] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const attachments = useAttachments(conversation);
  const fileDrop = useFileDrop(attachments);
  const voice = useVoiceNote(conversation, (sent) => reply(rootId, "", [sent.id]));
  const people = useData((s) => s.identities);
  const crew = useMemo(() => (people ?? []).filter((p) => p.kind === "agent" && !p.disabled), [people]);
  // Sending the reply brings a picked agent that is not in the conversation in (I-18, issue 35), as the main composer does.
  const mention = useMentionMenu({ text, setText, crew, focus: () => input.current?.focus() });

  useEffect(() => {
    input.current?.focus({ preventScroll: true });
    input.current?.scrollIntoView({ block: "nearest" });
  }, []);

  const files = attachments.items;
  const empty = text.trim() === "" && files.length === 0;
  const canSend = (text.trim() !== "" || files.length > 0) && files.every((f) => f.state === "done");
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!canSend) return;
    const sent = files.map((f) => f.upload!.id);
    setText("");
    attachments.clear();
    reply(rootId, text.trim(), sent);
  };
  const key = (event: KeyboardEvent) => {
    if (event.key !== "Escape") return;
    event.stopPropagation();
    stopReply();
  };
  return (
    <section className="ithread replying" aria-label={label} onKeyDown={key} {...fileDrop.handlers}>
      {fileDrop.overlay}
      <div className="ithbody">
        {parts}
        {toggle ? <div className="ithbar">{toggle}</div> : null}
        <form className="ithform" onSubmit={submit}>
          <AttachmentList attachments={attachments} />
          {voice.bar}
          <div className="composer glass thrcomposer" hidden={voice.recording}>
            <IconButton variant="muted" glyph={18} stroke={2} label="Attach a file to the reply" title="Attach a file" onClick={() => picker.current?.click()}>
              <AttachIcon />
            </IconButton>
            <input
              ref={picker}
              type="file"
              multiple
              aria-label="Attach files to the reply"
              hidden
              onChange={(e) => {
                attachments.add(Array.from(e.target.files ?? []));
                e.target.value = ""; // the same file can be chosen again
              }}
            />
            <label htmlFor="thr-composer" className="sr">
              Reply in thread
            </label>
            <MentionMenu mention={mention} crew={crew} invites={false} idPrefix="thr-" />
            <input
              ref={input}
              id="thr-composer"
              value={text}
              onChange={(e) => {
                setText(e.target.value);
                voice.clearNote();
                mention.changed(e.target.value);
              }}
              onKeyDown={(e) => {
                if (mention.keyDown(e) && e.key === "Escape") e.stopPropagation(); // Escape closes the menu, not the reply box
              }}
              onPaste={(e) => pasteFiles(e, attachments)}
              placeholder="Reply… Type @ to add an agent."
              autoComplete="off"
              enterKeyHint="send"
            />
            <span className="sendslot">
              {/* Send stays in the page (and disabled) under the microphone while there is nothing to send. */}
              <IconButton type="submit" variant="send" glyph={18} stroke={2} className={empty ? "opacity-0 pointer-events-none" : undefined} label="Send reply" disabled={!canSend} onMouseDown={keepFocus}>
                <SendIcon />
              </IconButton>
              <IconButton ref={voice.mic} variant="soft" glyph={18} stroke={2} className="absolute inset-0" label="Record a voice message" hidden={!empty} onMouseDown={keepFocus} onClick={voice.start}>
                <MicIcon />
              </IconButton>
            </span>
          </div>
          {voice.note}
          <Button variant="text" size="inline" className="ithcancel" onClick={stopReply}>
            Cancel reply
          </Button>
        </form>
      </div>
    </section>
  );
}
