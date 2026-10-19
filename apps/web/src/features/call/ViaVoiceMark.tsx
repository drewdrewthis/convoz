import type { Message } from "@convoz/api-client";

/** The mark under a message the owner's voice call posted, so a message that words from a model never passes as typed. */
export function ViaVoiceMark({ message }: { message: Message }) {
  if (!message.via_voice) return null;
  return <div className="viavoice">via voice call</div>;
}
