import type { NowWaiting } from "@convoz/api-client";
import { whoLine } from "@convoz/app-kit";
import { FoldList, FoldRow } from "./FoldList.tsx";

/** WaitingPlans lists the plan lines an agent waits on the owner for; each links to the plan of its conversation. */
export function WaitingPlans({ items }: { items: readonly NowWaiting[] }) {
  return (
    <section id="waiting-plans" className="block" aria-labelledby="waiting-plans-heading">
      <div className="block-head">
        <h2 id="waiting-plans-heading">Waiting on you</h2>
      </div>
      <FoldList>
        {items.map((it) => (
          <FoldRow key={`${it.conversation.id}|${it.agent.handle}|${it.text}`}>
            <a className="flex min-h-44 w-full flex-col justify-center gap-2 text-inherit no-underline" href={`/chats/${it.conversation.id}#plan`}>
              <span className="text-14 font-semibold">{it.text}</span>
              <span className="text-13 text-muted">{`${whoLine(it.agent)} · ${it.conversation.title || "Untitled conversation"}`}</span>
            </a>
          </FoldRow>
        ))}
      </FoldList>
    </section>
  );
}
