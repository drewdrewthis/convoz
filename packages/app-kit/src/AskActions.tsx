import { Button } from "@convoz/ui/Button";

/** The paths of the Quick reply and Snooze icons; the dev Now draws the same ones. */
export const REPLY_D = "M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z";
export const SNOOZE_D = "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 7v5l3 2";

/** Icon is one 18px stroke icon of the action row. */
export const Icon = ({ d }: { d: string }) => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={d} />
  </svg>
);

export interface AskActionsProps {
  /** Quick reply is offered. */
  quickReply: boolean;
  panel: string;
  toggle(p: "reply" | "snooze"): void;
  openHref?: string;
  onDismiss(): void;
  /** The sidebar's short row: Open conversation and Dismiss; no Quick reply or Snooze. */
  compact?: boolean;
}

/** AskActions is the row under an open ask: Quick reply, Snooze, Open and Dismiss. */
export function AskActions({ quickReply, panel, toggle, openHref, onDismiss, compact }: AskActionsProps) {
  return (
    <div className={compact ? "-mx-8 mt-8 flex flex-wrap" : "-mx-8 mb-14 flex flex-wrap"} role="group" aria-label="Ask actions">
      {quickReply && !compact ? (
        <Button variant="text" size="inline" aria-expanded={panel === "reply"} onClick={() => toggle("reply")}>
          <Icon d={REPLY_D} />
          Quick reply
        </Button>
      ) : null}
      {compact ? null : (
        <Button variant="text" size="inline" aria-haspopup="menu" aria-expanded={panel === "snooze"} onClick={() => toggle("snooze")}>
          <Icon d={SNOOZE_D} />
          Snooze
        </Button>
      )}
      {openHref ? (
        <Button variant="text" size="inline" href={openHref}>
          <Icon d="M7 17L17 7M8 7h9v9" />
          {compact ? "Open conversation" : "Open"}
        </Button>
      ) : null}
      <Button variant="text" size="inline" onClick={onDismiss}>
        <Icon d="M18 6L6 18M6 6l12 12" />
        Dismiss
      </Button>
    </div>
  );
}
