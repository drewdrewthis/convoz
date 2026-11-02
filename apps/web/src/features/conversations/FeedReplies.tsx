import type { Message } from "@convoz/api-client";
import { useData } from "../../shared/data.ts";
import { useThreads } from "../threads/index.ts";
import { ThreadBubbles } from "./Transcript.tsx";

const NO_PENDING: never[] = [];

/** FeedReplies draws the replies of a thread the way the conversation does (markdown, uploads, asks), for a card in the Now feed. Loaded on its own, like the conversation page. Replies the owner just sent show as sending, then as sent. */
export function FeedReplies({ conversation, root, replies }: { conversation: number; root: number; replies: Message[] }) {
  const me = useData((s) => s.me?.identity.handle ?? "");
  const pending = useThreads((s) => s.threads[root]?.pending) ?? NO_PENDING;
  return (
    <ThreadBubbles
      messages={replies}
      pending={pending}
      rootAt={replies[0]?.created_at ?? 0}
      me={me}
      conversation={conversation}
      onRetry={(cid) => void useThreads.getState().retry(root, cid)}
      onDiscard={(cid) => useThreads.getState().discard(root, cid)}
    />
  );
}
