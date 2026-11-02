/**
 * NOW_ORDER is the order of Now's blocks from the top, under the notes (the recovery banner and passkey hint stay fixed above it).
 * Machine requests lead: an agent waits on them and cannot work until the owner approves (owner, 2026-10-30). The cards of agents
 * the owner just approved follow, so the approval and its result stay together.
 */
export const NOW_ORDER = ["requests", "joined", "allClear", "noDecisions", "folds", "needs", "adds", "overdue", "mentions", "replies", "replied", "other"] as const;

/** One block of Now. */
export type NowSection = (typeof NOW_ORDER)[number];
