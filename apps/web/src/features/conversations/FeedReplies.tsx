import type { Message } from "@convoz/api-client";
import { useData } from "../../shared/data.ts";
import { ThreadBubbles } from "./Transcript.tsx";

const NO_PENDING: never[] = [];

/** FeedReplies draws the replies of a thread the way the conversation does (markdown, uploads, asks), for a card in the Now feed. Loaded on its own, like the conversation page. */
export function FeedReplies({ conversation, replies }: { conversation: number; replies: Message[] }) {
  const me = useData((s) => s.me?.identity.handle ?? "");
  return <ThreadBubbles messages={replies} pending={NO_PENDING} rootAt={replies[0]?.created_at ?? 0} me={me} conversation={conversation} onRetry={() => {}} onDiscard={() => {}} />;
}
