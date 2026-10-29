/** What a feed item's thread draws, from its state. Pure, so the rules of the Reply button are tested without a browser. */
export interface ThreadState {
  /** Replies known (server count plus unsent). */
  count: number;
  /** Goes up each time the Reply button is pressed. */
  request: number;
  /** The last request this state has already acted on. */
  seen: number;
  open: boolean;
  writing: boolean;
}

export interface ThreadParts {
  /** The one-line "Show thread · N replies" button: only when there are replies. */
  summary: boolean;
  /** The replies themselves. */
  replies: boolean;
  /** The reply box, in focus when it appears. */
  box: boolean;
  /** The "Reply here" button under an open thread whose box is closed. */
  replyHere: boolean;
}

/** takeRequest opens the thread with the box ready when a new Reply press came in. It is called while rendering, so the box is in the same frame as the press. */
export function takeRequest(s: ThreadState): ThreadState {
  return s.request === s.seen ? s : { ...s, seen: s.request, open: true, writing: true };
}

/** partsOf is what shows: nothing with no replies and no Reply press; a summary when there are replies; the box whenever Reply opened it. */
export function partsOf(s: ThreadState): ThreadParts {
  if (!s.count && !s.request) return { summary: false, replies: false, box: false, replyHere: false };
  return {
    summary: s.count > 0,
    replies: s.open && s.count > 0,
    box: s.open && s.writing,
    replyHere: s.open && !s.writing,
  };
}

/** boxShows is the empty reply box of an item with no thread yet (it has no message to hang replies on): hidden until Reply is pressed. */
export const boxShows = (request: number): boolean => request > 0;
