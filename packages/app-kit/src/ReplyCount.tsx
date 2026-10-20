export interface ReplyCountProps {
  /** The replies in the thread; nothing is drawn for none. */
  count?: number;
  /** The ones the viewer has not read: "· 1 new", emphasised. */
  unread?: number;
}

/**
 * ReplyCount is the small count beside every "Reply in thread": how many replies the thread has and how many of them are new to the
 * viewer, so a thread and its news show at a glance (owner, msg 1202). It draws nothing for a thread with no replies.
 */
export function ReplyCount({ count = 0, unread = 0 }: ReplyCountProps) {
  if (count <= 0) return null;
  const fresh = Math.min(unread, count);
  return (
    <span className="replycount text-13 font-normal text-muted" data-replies={count} data-unread={fresh}>
      {`${count} ${count === 1 ? "reply" : "replies"}`}
      {fresh > 0 ? <b className="replynew font-semibold text-accent-text">{` · ${fresh} new`}</b> : null}
    </span>
  );
}
