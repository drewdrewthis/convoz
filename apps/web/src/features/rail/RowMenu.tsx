import { Field } from "@convoz/ui/Field";
import { MenuItem } from "@convoz/ui/MenuItem";
import type { Conversation } from "@convoz/api-client";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { markAllRead, renameConversation } from "../conversations/index.ts";
import { toast } from "../pins-stars/index.ts";
import { humanError } from "../../shared/api.ts";
import { isOlder, titleOf } from "./model.ts";
import { setStale, setStar } from "./actions.ts";

/** Where the menu opens: under the dots button of conversation `c`. */
export interface RowMenuAt {
  c: Conversation;
  x: number;
  y: number;
}

/**
 * RowMenu is the menu of one rail row (its dots button): Rename, Mark stale or Bring back, Star or Unstar, Mark read. Rename turns the
 * menu into a field: Enter saves, Escape cancels. A row under Older has Bring back, whether marked stale or quiet for 48 hours; a starred
 * row has neither, as it never goes Older. Escape or a press anywhere else closes the menu and the focus goes back to its button.
 */
export function RowMenu({ at, onClose }: { at: RowMenuAt; onClose(): void }) {
  const { c } = at;
  const [renaming, setRenaming] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    box.current?.querySelector<HTMLElement>(renaming ? "input" : "[role=menuitem]")?.focus();
  }, [renaming]);
  const close = () => {
    onClose();
    document.getElementById(`rm-${c.id}`)?.focus();
  };
  useEffect(() => {
    const away = (e: Event) => !(e.target as Element).closest(".railmenu") && onClose();
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [onClose]);
  const run = (job: Promise<unknown>, said: string) => {
    close();
    job.then(() => toast(said), (err) => toast(humanError(err) || "That did not work."));
  };
  const key = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      close();
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      const items = [...(box.current?.querySelectorAll<HTMLElement>("[role=menuitem]") ?? [])];
      const next = items.indexOf(document.activeElement as HTMLElement) + (e.key === "ArrowDown" ? 1 : -1);
      items[(next + items.length) % items.length]?.focus();
      e.preventDefault();
    }
  };
  const saveName = (e: KeyboardEvent<HTMLInputElement>) => {
    const title = e.currentTarget.value.trim();
    if (e.key !== "Enter" || !title) return;
    e.preventDefault();
    run(title === titleOf(c) ? Promise.resolve() : renameConversation(c.id, title), "Renamed");
  };
  const older = isOlder(c);
  return (
    // eslint-disable-next-line convoz/no-style-prop -- the place is the button's position on the screen, known only at run time
    <div ref={box} tabIndex={-1} className="menu railmenu" role="menu" aria-label={`Actions for ${titleOf(c)}`} style={{ position: "fixed", left: Math.max(8, Math.min(at.x, innerWidth - 296)), top: at.y }} onKeyDown={key}>
      {renaming ? (
        <Field label="Rename conversation" defaultValue={titleOf(c)} maxLength={120} onKeyDown={saveName} />
      ) : (
        <>
          <MenuItem onClick={() => setRenaming(true)}>Rename</MenuItem>
          {c.starred ? null : <MenuItem onClick={() => run(setStale(c.id, !older), older ? "Brought back" : "Marked stale")}>{older ? "Bring back" : "Mark stale"}</MenuItem>}
          <MenuItem onClick={() => run(setStar(c.id, !c.starred), c.starred ? "Unstarred" : "Starred")}>{c.starred ? "Unstar" : "Star"}</MenuItem>
          <MenuItem onClick={() => run(markAllRead(c.id), "Marked read")}>Mark read</MenuItem>
        </>
      )}
    </div>
  );
}
