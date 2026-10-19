import type { Message } from "@convoz/api-client";
import { Sheet } from "@convoz/ui/Sheet";
import { useEffect, useRef, useState } from "react";
import { humanError } from "../../../shared/api.ts";
import { useThreads } from "../../threads/index.ts";
import { useData } from "../../../shared/data.ts";
import { pinMessage, toast, unpinMessage } from "../../pins-stars/index.ts";
import { deleteMessage, editHistory, editMessage, transcribeAgain } from "./actions.ts";
import { Button } from "@convoz/ui/Button";

/**
 * MessageMenu is the "Message actions" button of one message and what it opens. The button is invisible until the row is
 * hovered or focused (a long press does the same on touch), so a message looks as the prototype draws it.
 */
export function MessageMenu({ message, mine, conversation }: { message: Message; mine: boolean; conversation: number }) {
  const [open, setOpen] = useState(false);
  const pinned = useData((s) => Boolean(s.rows[conversation]?.pinned?.some((x) => x.id === message.id)));
  const [sheet, setSheet] = useState<"edit" | "delete" | null>(null);
  const press = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
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
  const inOpenThread = useThreads((s) => s.open?.rootId === rootId);

  useEffect(() => {
    if (!open) return;
    const away = (e: Event) => root.current && !root.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [open]);

  return (
    <span className="msg-actions" ref={root}>
      <button
        className="msg-actions-btn"
        type="button"
        aria-label="Message actions"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        onTouchStart={() => (press.current = setTimeout(() => setOpen(true), 450))}
        onTouchEnd={() => clearTimeout(press.current)}
        onTouchMove={() => clearTimeout(press.current)}
      />
      {open ? (
        <div className="msg-menu" role="menu">
          {inOpenThread ? null : (
            <button role="menuitem" type="button" onClick={() => (setOpen(false), void useThreads.getState().openThread(conversation, rootId, message.thread_root_id ? undefined : message))}>
              Reply in thread
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
