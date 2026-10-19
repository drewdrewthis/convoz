import type { Message } from "@convoz/api-client";
import { ChevronIcon } from "@convoz/ui/icons";
import { createContext, useContext, useState } from "react";
import { stripCf } from "../../../shared/chat.ts";
import { usePlans } from "../../plan/index.ts";

/** OpenDetails opens the details panel of the conversation; the page provides it, so a row can send the owner there. */
export const OpenDetails = createContext<() => void>(() => {});

/** What a plan.changed line quotes (owner msg 632): the items as the agent wrote them, each optional. */
interface PlanLineParts {
  identity?: { handle: string };
  done?: string;
  now?: string;
  next?: string;
  waiting?: string;
}

const LINES: [keyof PlanLineParts, string][] = [["done", "Done"], ["now", "Now"], ["next", "Next"], ["waiting", "Waiting"]];

/**
 * PlanNote is a plan update in the chat: one muted row, "@handle updated its plan", with what it does Now cut to one line and, while
 * something waits on the owner, a pill that opens the details panel (msg 632: "not sure what this little text is?"). Tapping the row
 * opens Done, Now, Next and Waiting as short labelled lines. The pill counts what waits now (the live board), not what the line quoted.
 */
export function PlanNote({ message, conversation }: { message: Message; conversation: number }) {
  const [open, setOpen] = useState(false);
  const openDetails = useContext(OpenDetails);
  const s = (message.system ?? {}) as PlanLineParts;
  const handle = s.identity?.handle ?? "";
  const waiting = usePlans((st) => st.boards[conversation]?.plans.find((p) => p.handle === handle)?.waiting.length ?? 0);
  return (
    <div className="notice-line plan-note" role="note" data-t="plan.changed">
      <button type="button" className="pn-main" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <svg className="pn-icon" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01" />
        </svg>
        <span className="pn-who">{`@${handle} updated its plan`}</span>
        {s.now ? <span className="pn-now">{`Now: ${stripCf(s.now)}`}</span> : null}
        <span className="pn-chev" aria-hidden="true">
          <ChevronIcon />
        </span>
      </button>
      {waiting > 0 ? (
        <button type="button" className="pn-pill" onClick={openDetails}>
          {`Waiting on you · ${waiting}`}
        </button>
      ) : null}
      {open ? (
        <dl className="pn-lines">
          {LINES.filter(([k]) => s[k]).map(([k, label]) => (
            <div key={k}>
              <dt>{label}</dt>
              <dd>{stripCf(s[k] as string)}</dd>
            </div>
          ))}
        </dl>
      ) : null}
    </div>
  );
}
