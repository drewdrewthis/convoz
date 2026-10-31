import type { WaitingUnanswered } from "@convoz/api-client";

/** The marker of the card: an agent owes the owner an answer; the owner blocks no one. */
export const UNANSWERED_LABEL = "No reply yet";

/** unansweredFrame is what the card of an unanswered owner message shows. A chat with no title is named by the cached title, then by its members' handles. */
export function unansweredFrame(u: WaitingUnanswered, titles: (id: number) => string) {
  const id = u.conversation.id;
  const members = u.members.length ? `@${u.members.join(" @")}` : "";
  return {
    title: "You asked",
    context: u.excerpt,
    href: `/chats/${id}#m${u.message_id}`,
    from: { id, title: u.conversation.title || titles(id) || members },
  };
}
