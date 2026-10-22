import type { ReactNode } from "react";
import { CallTimer } from "./CallTimer.tsx";
import { useCall } from "./store.ts";
import { Button } from "@convoz/ui/Button";

/**
 * CallBar is the call sheet: under the title bar, so the messages and the box stay in reach. A status line, Mute and Hang up. It shows
 * the call of this conversation, and a Now call that goes on while the owner reads here (with its time, as the pill has).
 */
export function CallBar({ conversationId }: { conversationId: number }) {
  const target = useCall((s) => s.target);
  if (target !== conversationId && target !== "now") return null;
  return (
    <section className="callbar" aria-label="Call">
      <CallControls>{target === "now" ? <CallTimer /> : null}</CallControls>
    </section>
  );
}

/** CallControls are what the bar and the pill share: the status line, anything put beside it, and Mute and Hang up (Close once over). */
export function CallControls({ children }: { children?: ReactNode }) {
  const { status, muted, ended, toggleMute, hangUp } = useCall();
  return (
    <>
      <p role="status" className="callstatus">
        {status}
      </p>
      {children}
      {ended ? (
        <Button className="flex-none" size="small" onClick={hangUp}>
          Close
        </Button>
      ) : (
        <>
          <Button className="flex-none" size="small" aria-pressed={muted} onClick={toggleMute}>
            {muted ? "Unmute" : "Mute"}
          </Button>
          <Button className="flex-none" variant="danger" size="small" onClick={hangUp}>
            Hang up
          </Button>
        </>
      )}
    </>
  );
}
