import type { Ask } from "@convoz/api-client";
import { stateLine, whoLine } from "@convoz/app-kit";
import { Button } from "@convoz/ui/Button";
import { useId, type ReactNode } from "react";
import { FoldList, FoldRow } from "./FoldList.tsx";

export type FoldKey = "snoozed" | "answered" | "dismissed";

/** untilText is a snooze end as the owner reads it: the time today, else the weekday and the time. */
function untilText(at: number): string {
  const d = new Date(at);
  const today = new Date().toDateString() === d.toDateString();
  return d.toLocaleString([], today ? { hour: "numeric", minute: "2-digit" } : { weekday: "short", hour: "numeric", minute: "2-digit" });
}

const who = (ask: Ask) => `${whoLine(ask.asker)} · ${ask.conversation?.title || "Untitled conversation"}`;

interface FoldsProps {
  snoozed: Ask[];
  answered: Ask[];
  dismissed: Ask[];
  open: Record<FoldKey, boolean>;
  toggle: (k: FoldKey) => void;
  unsnooze: (ask: Ask) => void;
  reopen: (ask: Ask) => void;
  /** Nothing waits: the chips are centred under the all-clear line; with items they stay left. */
  centered: boolean;
}

/** Folds are the chips under the top bar ("Snoozed · 1", "Answered today · 3", "Dismissed today · 1") and, when one is open, its rows. A chip is not there when it has no rows. */
export function Folds({ snoozed, answered, dismissed, open, toggle, unsnooze, reopen, centered }: FoldsProps) {
  const id = useId();
  if (!snoozed.length && !answered.length && !dismissed.length) return null;
  const chip = (key: FoldKey, name: string, rows: Ask[]) =>
    rows.length ? (
      <Button variant="muted" size="chip" onMouseDown={(e) => e.preventDefault()} aria-expanded={open[key]} aria-controls={`${id}-${key}`} onClick={() => toggle(key)}>
        <span>{name}</span>
        <span aria-hidden="true">·</span>
        <span>{rows.length}</span>
        <svg className="size-12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M6 9l6 6 6-6" />
        </svg>
      </Button>
    ) : null;
  const rowsOf = (key: FoldKey, rows: Ask[], tail: (ask: Ask) => ReactNode) =>
    open[key] && rows.length ? (
      <FoldList id={`${id}-${key}`}>
        {rows.map((ask) => (
          <FoldRow key={ask.id}>
            <a className="text-14 font-semibold text-inherit no-underline" href={`/chats/${ask.conversation_id}#m${ask.id}`}>
              {ask.question}
            </a>
            <span className="text-13 text-muted">{who(ask)}</span>
            <div className="-mx-8 flex flex-wrap items-center">
              {tail(ask)}
              <Button variant="text" size="inline" href={`/chats/${ask.conversation_id}#reply=${ask.thread_root_id ?? ask.id}`}>
                Reply in thread
              </Button>
              <Button variant="text" size="inline" href={`/chats/${ask.conversation_id}#m${ask.id}`}>
                Jump to conversation
              </Button>
            </div>
          </FoldRow>
        ))}
      </FoldList>
    ) : null;
  const state = (text: string) => <span className="px-8 text-13 text-muted">{text}</span>;
  return (
    <div className="flex flex-col items-stretch gap-8 pt-2 pb-12">
      {/* foldchips is the hook of the e2e specs that measure the centring. */}
      <div className={`foldchips flex flex-wrap gap-8${centered ? " justify-center" : ""}`}>
        {chip("snoozed", "Snoozed", snoozed)}
        {chip("answered", "Answered today", answered)}
        {chip("dismissed", "Dismissed today", dismissed)}
      </div>
      {rowsOf("snoozed", snoozed, (ask) => (
        <>
          {state(`Snoozed until ${untilText(ask.snoozed_until ?? 0)}`)}
          <Button variant="text" size="inline" onClick={() => unsnooze(ask)}>
            Unsnooze
          </Button>
        </>
      ))}
      {rowsOf("answered", answered, (ask) => state(stateLine(ask)))}
      {rowsOf("dismissed", dismissed, (ask) => (
        <>
          {state("Dismissed")}
          <Button variant="text" size="inline" onClick={() => reopen(ask)}>
            Reopen
          </Button>
        </>
      ))}
    </div>
  );
}
