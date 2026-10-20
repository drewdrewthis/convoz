// The Tier 1 app kits (design E-1..E-4): React components an app message renders with, validated against app.v1.
// The ask card sits here too: Now and the transcript draw the same card.
export { AskCard } from "./AskCard.tsx";
export { stateLine, whoLine } from "./askData.ts";
export { ReplyCount } from "./ReplyCount.tsx";
export { DraftReview } from "./DraftReview.tsx";
export type { DraftData } from "./DraftReview.tsx";
export type { AskCardProps } from "./AskCard.tsx";
export type { Answer, AskData, AskHistoryItem, AskPerson, SnoozePreset } from "./askData.ts";
export { validateApp, validateBridge, validateResult } from "./validate.ts";
export type { Verdict } from "./validate.ts";
export { parseDiff } from "./tier1/Code.tsx";
export type * from "./types.ts";
export { KIT_VERSION } from "./kit.ts";
