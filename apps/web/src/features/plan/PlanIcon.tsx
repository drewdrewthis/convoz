import { AlertIcon, ClockIcon, HandIcon } from "@convoz/ui/icons";
import { useEffect } from "react";
import { dotOf } from "./format.ts";
import { ALL, usePlans } from "./store.ts";

let asked = false;

/**
 * PlanIcon is the status icon of one conversation row, next to its unread count (msgs 100, 263 and 382): a hand when something waits on
 * the owner, an alert when blocked, a clock when late or not responding, a green working dot; nothing when quiet. Its name and tooltip
 * say the state, so colour and shape are never alone.
 */
export function PlanIcon({ id }: { id: number }) {
  const dot = dotOf(usePlans((s) => s.boards[ALL]?.attention.find((a) => a.conversation_id === id)));
  useEffect(() => {
    if (asked) return;
    asked = true; // one read for the whole list; the stream keeps it fresh
    void usePlans.getState().load(ALL).catch(() => (asked = false));
  }, []);
  if (!dot) return null;
  const Icon = dot.label === "Waiting on you" ? HandIcon : dot.label === "Blocked" ? AlertIcon : dot.label === "Working" ? null : ClockIcon;
  return (
    <span className="planicon" role="img" aria-label={dot.label} title={dot.label} data-tone={dot.tone}>
      {Icon ? <Icon /> : <span className="spin" />}
    </span>
  );
}
