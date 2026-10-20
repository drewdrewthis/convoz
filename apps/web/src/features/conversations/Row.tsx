// One row of the conversation list, shared by the plain list and the virtualized one (VirtualList.tsx, its own chunk).
import type { Conversation } from "@convoz/api-client";
import { memo, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { stripCf, whenLabel } from "../../shared/chat.ts";
import { PlanIcon } from "../plan/index.ts";
import { ThreadFold, ThreadRows } from "../threads/index.ts";
import { GripIcon, startDrag, type Drop } from "../rail/index.ts";

/** The Reorder mode of the list: handles on the rows of Starred and Conversations (Older rows keep still) until Done. */
export interface ReorderMode {
  on: boolean;
  drop(d: Drop): void;
  step(e: ReactKeyboardEvent<HTMLElement>, c: Conversation): void;
}

export interface RowProps {
  c: Conversation;
  me: string;
  index?: number;
  measure?: (el: Element | null) => void;
  style?: CSSProperties;
  /** The group of a row that can be moved (Older rows have none). */
  grp?: "starred" | "mid";
  mode?: ReorderMode;
}

/** Row is one conversation; a row whose data did not change keeps its node, so a selection in it survives an update. */
export const Row = memo(function Row({ c, me, index, measure, style, grp, mode }: RowProps) {
  const moving = Boolean(mode?.on && grp);
  const mainUnread = c.main_unread ?? c.unread;
  const unread = mainUnread > 0;
  const preview = c.last ? `${c.last.author_handle === me ? "You" : c.last.author_handle}: ${c.last.preview}` : "No messages yet";
  return (
    <li className={`${unread ? "unread" : ""}${c.muted_until ? " muted" : ""}`.trim() || undefined} data-id={c.id} data-rid={moving ? c.id : undefined} data-grp={moving ? grp : undefined} data-index={index} ref={measure} style={style}>
      <a className="chatrow" href={`/chats/${c.id}`} draggable={false} onClick={moving ? (e) => e.preventDefault() : undefined}>
        <div className="rowbody">
          <div className="rowtop">
            <h2 className="rowtitle">{stripCf(c.title ?? "") || "New conversation"}</h2>
            <span className="sp" />
            <time className="when">{whenLabel(c.last_activity_at)}</time>
          </div>
          <div className="preview">{preview}</div>
        </div>
        <PlanIcon id={c.id} />
        {unread ? (
          <span className="count">
            <span className="sr">Unread: </span>
            <span>{mainUnread > 99 ? "99+" : String(mainUnread)}</span>
          </span>
        ) : null}
      </a>
      <ThreadFold c={c} />
      {moving && mode ? (
        <button
          type="button"
          className="listgrab"
          id={`lg-${c.id}`}
          aria-label={`Reorder ${stripCf(c.title ?? "") || "New conversation"}. Alt plus arrow keys move it.`}
          onPointerDown={(e) => startDrag(e, mode.drop)}
          onKeyDown={(e) => mode.step(e, c)}
        >
          <GripIcon />
        </button>
      ) : null}
      <ThreadRows c={c} />
    </li>
  );
});

