import { useCall } from "./store.ts";
import { Button } from "@convoz/ui/Button";

/** CallBar is the call sheet: under the title bar, so the messages and the box stay in reach. A status line, Mute and Hang up. */
export function CallBar({ conversationId }: { conversationId: number }) {
  const { conversation, status, muted, ended, toggleMute, hangUp } = useCall();
  if (conversation !== conversationId) return null;
  return (
    <section className="callbar" aria-label="Call">
      <p role="status" className="callstatus">
        {status}
      </p>
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
    </section>
  );
}
