import type { Ask } from "@convoz/api-client";
import { ReplyCount, whoLine } from "@convoz/app-kit";
import { List, ListRow } from "@convoz/ui/ListRow";
import { visit } from "../../shared/navigate.ts";
import { ago } from "./Unread.tsx";

/** href is the thread of an ask, where the owner's reply is and where the agent's updated ask will come. */
const threadOf = (ask: Ask) => `/chats/${ask.conversation_id}#reply=${ask.thread_root_id ?? ask.id}`;

/**
 * NowReplied is "You replied · waiting on the agent" (owner, msg 1131): the open asks the owner answered with questions in the thread
 * instead of a choice. They wait on the agent's updated ask, so they leave the list of what needs the owner. A row opens the thread.
 */
export function NowReplied({ asks }: { asks: Ask[] }) {
  return (
    <section id="replied" className="mb-8" aria-labelledby="replied-head">
      <p id="replied-head" className="ghdr">You replied · waiting on the agent</p>
      <List flush>
        {asks.map((ask) => (
          <ListRow key={ask.id} as="a" href={threadOf(ask)} onClick={(e) => visit(e, threadOf(ask))} stacked data-replied={ask.id}>
            <span className="text-15 font-semibold [overflow-wrap:anywhere]">{ask.question}</span>
            <span className="text-13 text-muted">
              {`${whoLine(ask.asker)} · ${ago(ask.owner_reply?.at ?? ask.created_at)}`}
              {ask.reply_count ? " · " : null}
              <ReplyCount count={ask.reply_count} unread={ask.unread_replies} />
            </span>
            {ask.owner_reply?.text ? <span className="text-13 text-muted [overflow-wrap:anywhere]">{`You: ${ask.owner_reply.text}`}</span> : null}
          </ListRow>
        ))}
      </List>
    </section>
  );
}
