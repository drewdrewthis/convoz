import type { PlanAttention } from "@convoz/api-client";
import { lineOf, usePlans } from "../plan/index.ts";

/** PlanLine is the one line under a conversation's title: the most urgent state across its agents (Waiting on you › Blocked › Not
 *  responding › Late › Working › Done), in the owner's time zone. Tapping it opens the details panel. */
export function PlanLine({ attention, onOpen }: { attention: PlanAttention; onOpen(): void }) {
  const skew = usePlans((s) => s.skew);
  const { text, tone } = lineOf(attention, Date.now() + skew);
  return (
    <button id="planline" type="button" className={`planline${tone === "amber" ? " amber" : ""}`} aria-haspopup="dialog" onClick={onOpen}>
      <span className="pdot" data-tone={tone} aria-hidden="true" />
      <span className="pltext">{text}</span>
    </button>
  );
}
