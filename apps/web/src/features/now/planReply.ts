import type { NowWaiting } from "@convoz/api-client";

/**
 * planReply is what Reply on a plan waiting item posts: a plan item has no message to reply under, so it is a message in the
 * item's conversation that names the waiting agent; null for blank text (owner, 2026-10-30, conv 179 msg 14202: Reply "went to
 * the conversation itself instead of the mini reply").
 */
export function planReply(plan: Pick<NowWaiting, "conversation" | "agent">, text: string): { conversation: number; body: string } | null {
  const said = text.trim();
  return said ? { conversation: plan.conversation.id, body: `@${plan.agent.handle} ${said}` } : null;
}
