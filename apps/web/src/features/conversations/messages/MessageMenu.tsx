import type { Message } from "@convoz/api-client";
import { Sheet } from "@convoz/ui/Sheet";
import { useEffect, useRef, useState } from "react";
import { humanError } from "../../../shared/api.ts";
import { ReplyCount } from "@convoz/app-kit";
import { useNewReplies, useThreads } from "../../threads/index.ts";
import { useData } from "../../../shared/data.ts";
import { pinMessage, toast, unpinMessage } from "../../pins-stars/index.ts";
import { deleteMessage, editHistory, editMessage, transcribeAgain } from "./actions.ts";
import { Button } from "@convoz/ui/Button";
import { MenuItem } from "@convoz/ui/MenuItem";
import { IconButton } from "@convoz/ui/IconButton";
import { ReplyIcon } from "@convoz/ui/icons";

/**
 * MessageMenu is the "Message actions" button of one message and what it opens. The button is invisible until the row is
 * hovered or focused (a long press anywhere on the message does the same on touch), so a message looks as the prototype draws it.
 */
export function MessageMenu({ message, mine, conversation }: { message: Message; mine: boolean; conversation: number }) {
  const [open, setOpen] = useState(false);
  const pinned = useData((s) => Boolean(s.rows[conversation]?.pinned?.some((x) => x.id === message.id)));
  const [sheet, setSheet] = useState<"edit" | "delete" | null>(null);
  const root = useRef<HTMLSpanElement>(null);
  const voice = message.uploads?.find((u) => u.kind === "audio");
  // "Transcribe again" that gave up puts the earlier words back with redo_failed: say so once, when it flips.
  const redoFailed = Boolean(voice?.transcript?.redo_failed);
  const wasFailed = useRef(redoFailed);
  useEffect(() => {
    if (redoFailed && !wasFailed.current) toast("Could not transcribe again");
    wasFailed.current = redoFailed;
  }, [redoFailed]);
  const rootId = message.thread_root_id ?? message.id;
  const fresh = useNewReplies(message);
  const inOpenThread = useThreads((s) => s.replying === rootId);
  const replyHere = () => useThreads.getState().startReply(conversation, rootId);

  // A phone never hovers, so there the button stays invisible and only a 44 px corner took the long press: the owner could not find a
  // way into a thread (conv 9, msg 2708). The whole message takes it now.
  useEffect(() => {
    const row = root.current?.closest("article");
    if (!row) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let from: { x: number; y: number } | null = null;
    let held = false;
    const start = (e: TouchEvent) => {
      held = false;
      clearTimeout(timer);
      const t = e.touches[0];
      from = e.touches.length === 1 && t ? { x: t.clientX, y: t.clientY } : null;
      if (from) timer = setTimeout(() => ((held = true), setOpen(true)), 450);
    };
    // A finger always jitters a little; only a real move (a scroll) is not a long press.
    const move = (e: TouchEvent) => {
      const t = e.touches[0];
      if (!from || !t || Math.hypot(t.clientX - from.x, t.clientY - from.y) > 10) clearTimeout(timer);
    };
    const end = () => clearTimeout(timer);
    // The click a phone may send when the finger lifts after a long press would toggle the menu shut again or follow a link.
    const swallow = (e: MouseEvent) => {
      if (!held) return;
      held = false;
      e.preventDefault();
      e.stopPropagation();
    };
    row.addEventListener("touchstart", start, { passive: true });
    row.addEventListener("touchmove", move, { passive: true });
    row.addEventListener("touchend", end, { passive: true });
    row.addEventListener("touchcancel", end, { passive: true });
    row.addEventListener("click", swallow, true);
    return () => {
      clearTimeout(timer);
      row.removeEventListener("touchstart", start);
      row.removeEventListener("touchmove", move);
      row.removeEventListener("touchend", end);
      row.removeEventListener("touchcancel", end);
      row.removeEventListener("click", swallow, true);
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    const away = (e: Event) => root.current && !root.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [open]);

  return (
    <span className="msg-actions" ref={root}>
      {/* The reply arrow beside ⋯ shows where a pointer hovers; a touch screen reaches Reply in thread through ⋯ and a long press. A reply
          has none: its thread has its own Reply. */}
      {inOpenThread || message.thread_root_id ? null : (
        <IconButton variant="muted" glyph={18} stroke={2} className="msg-reply-btn" label="Reply in thread" title="Reply in thread" onClick={replyHere}>
          <ReplyIcon />
        </IconButton>
      )}
      <button
        className="msg-actions-btn"
        type="button"
        aria-label="Message actions"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      />
      {open ? (
        <div className="msg-menu" role="menu">
          {inOpenThread ? null : (
            <button role="menuitem" type="button" onClick={() => (setOpen(false), replyHere())}>
              Reply in thread
              {message.thread_root_id ? null : <ReplyCount count={message.reply_count} unread={fresh} />}
            </button>
          )}
          <button
            role="menuitem"
            type="button"
            onClick={() => {
              setOpen(false);
              (pinned ? unpinMessage : pinMessage)(conversation, message.id).catch((err) => toast(humanError(err)));
            }}
          >
            {pinned ? "Unpin" : "Pin"}
          </button>
          <MenuItem onClick={() => (setOpen(false), copyLink(conversation, message.id))}>
            Copy link
          </MenuItem>
          {message.author.kind === "agent" ? (
            <MenuItem onClick={() => (setOpen(false), askForMiniApp(conversation, rootId, message.author.handle))}>
              Request mini app
            </MenuItem>
          ) : null}
          {voice ? (
            <button
              role="menuitem"
              type="button"
              onClick={() => {
                setOpen(false);
                transcribeAgain(voice.id).catch((err) => toast(humanError(err)));
              }}
            >
              Transcribe again
            </button>
          ) : null}
          {mine ? (
            <button role="menuitem" type="button" onClick={() => (setOpen(false), setSheet("edit"))}>
              Edit
            </button>
          ) : null}
          <button role="menuitem" type="button" onClick={() => (setOpen(false), setSheet("delete"))}>
            Delete
          </button>
        </div>
      ) : null}
      {sheet === "edit" ? <EditSheet message={message} close={() => setSheet(null)} /> : null}
      {sheet === "delete" ? <DeleteSheet message={message} close={() => setSheet(null)} /> : null}
    </span>
  );
}

function EditSheet({ message, close }: { message: Message; close(): void }) {
  const [text, setText] = useState(message.body);
  const [alert, setAlert] = useState("");
  const save = async () => {
    try {
      await editMessage(message.id, text);
      close();
    } catch (err) {
      setAlert(humanError(err));
    }
  };
  return (
    <Sheet
      title="Edit message"
      alert={alert}
      onClose={close}
      actions={
        <>
          <Button disabled={!text.trim()} onClick={save}>
            Save
          </Button>
          <Button variant="quiet" onClick={close}>
            Cancel
          </Button>
        </>
      }
    >
      <textarea aria-label="Message text" rows={4} value={text} onChange={(e) => setText(e.target.value)} autoFocus />
    </Sheet>
  );
}

export function DeleteSheet({ message, close }: { message: Message; close(): void }) {
  const [alert, setAlert] = useState("");
  const remove = async () => {
    try {
      await deleteMessage(message.id);
      close();
    } catch (err) {
      setAlert(humanError(err));
    }
  };
  return (
    <Sheet
      title="Delete this message?"
      alert={alert}
      onClose={close}
      actions={
        <>
          <Button variant="danger" onClick={remove}>
            Delete
          </Button>
          <Button variant="quiet" onClick={close}>
            Cancel
          </Button>
        </>
      }
    >
      <p>It stays as &ldquo;Message deleted&rdquo; in the conversation.</p>
    </Sheet>
  );
}

/** EditedMark is "(edited)": a button that opens the earlier texts. */
export function EditedMark({ id }: { id: number }) {
  const [list, setList] = useState<{ body: string; edited_at: number }[] | null>(null);
  const [alert, setAlert] = useState("");
  const show = async () => {
    try {
      setList((await editHistory(id)).edits);
    } catch (err) {
      setAlert(humanError(err));
      setList([]);
    }
  };
  return (
    <>
      <button className="edited" type="button" onClick={show}>
        (edited)
      </button>
      {list ? (
        <Sheet
          title="Edit history"
          alert={alert}
          onClose={() => setList(null)}
          actions={
            <Button variant="quiet" onClick={() => setList(null)}>
              Close
            </Button>
          }
        >
          <ol className="edit-history">
            {list.map((e) => (
              <li key={e.edited_at}>{e.body}</li>
            ))}
          </ol>
        </Sheet>
      ) : null}
    </>
  );
}

/** copyLink puts the full link of a message on the clipboard; when the browser refuses, it shows the link to copy by hand. */
function copyLink(conversation: number, id: number) {
  copyUrl(`${location.origin}/chats/${conversation}#m${id}`);
}

/** copyUrl is the copy of a link: "Link copied", or the link in a prompt when the browser refuses the clipboard. */
export function copyUrl(url: string) {
  const byHand = () => window.prompt("Copy this link", url);
  if (!navigator.clipboard) return void byHand();
  navigator.clipboard.writeText(url).then(() => toast("Link copied"), byHand);
}

/** askForMiniApp replies in the thread of an agent's message, asking that agent to turn the message into a mini app. */
function askForMiniApp(conversation: number, rootId: number, handle: string) {
  const threads = useThreads.getState();
  threads.startReply(conversation, rootId);
  void threads.reply(rootId, miniAppRequest(handle, conversation));
}

/** miniAppRequest is the reply "Request mini app" posts: what a mini app is, when it helps, and how to make a good one. */
function miniAppRequest(handle: string, conv: number): string {
  return `@${handle}, please turn this message into a mini app instead of more text.\n\nA mini app is a small web page you post in the chat; it opens in place. It beats a wall of text when I must compare options, see a layout or a flow, check numbers, or click through choices.\n\nHow:\n\n\`\`\`\nconvoz app init ./my-app      # makes the starter files\nconvoz app build ./my-app     # builds dist/app.html and dist/app.json\nconvoz app validate ./my-app/dist/app.html\nconvoz post ${conv} --app ./my-app/dist/app.json "one line on what it shows"\n\`\`\`\n\nSee \`convoz app --help\`.\n\nGood looks like: one question per app, the answer or recommendation at the top, real data (no lorem ipsum), plain words, works on a phone, and one clear action for me if you need a decision.`;
}
