import type { Delivery } from "@convoz/api-client";
import { Button } from "@convoz/ui/Button";
import { useEffect } from "react";
import { visit } from "../../shared/navigate.ts";
import { useDeliveries } from "../delivery/index.ts";
import { when } from "../plan/index.ts";
import { FoldList, FoldRow } from "./FoldList.tsx";

const SHOWN = 3;

/** useOverdue is the deliverables past their date; the agent was asked first, so they never count in Needs you or the badge. */
export function useOverdue(): Delivery[] {
  useEffect(() => useDeliveries.getState().ensure(), []);
  const data = useDeliveries((s) => s.data);
  return data?.deliveries.filter((d) => d.state === "late") ?? [];
}

/** Overdue is the Now group of deliverables past their date (owner, conv 179 msg 9734): three at most, the most overdue first, and
 *  a way to the whole Work page. */
export function Overdue({ late }: { late: Delivery[] }) {
  const now = Date.now() + useDeliveries((s) => s.skew);
  if (!late.length) return null;
  return (
    <section id="overdue" aria-labelledby="overdue-heading" className="mb-8">
      <p id="overdue-heading" className="ghdr">{`Overdue · ${late.length}`}</p>
      <FoldList>
        {late.slice(0, SHOWN).map((d) => (
          <FoldRow key={`${d.conversation_id}-${d.identity_id}-${d.text}`}>
            <a className="text-14 font-semibold text-inherit no-underline [overflow-wrap:anywhere]" href={`/chats/${d.conversation_id}`} onClick={(e) => visit(e, `/chats/${d.conversation_id}`)}>
              {d.text}
            </a>
            <span className="text-13 text-muted">{`@${d.handle} · was due ${when(d.due, now)}`}</span>
          </FoldRow>
        ))}
      </FoldList>
      <Button variant="text" size="inline" href="/work" onClick={(e) => visit(e, "/work")}>
        See all work
      </Button>
    </section>
  );
}
