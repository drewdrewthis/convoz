import type { Message } from "@convoz/api-client";

/** The mark under a message the owner sent through an app of an agent (I-46): "via app by @devtool". */
export function ViaAppMark({ message }: { message: Message }) {
  if (!message.via_app) return null;
  return <div className="viaapp appmeta" data-via-app={message.via_app.message_id}>{`via app by @${message.via_app.agent.handle}`}</div>;
}
