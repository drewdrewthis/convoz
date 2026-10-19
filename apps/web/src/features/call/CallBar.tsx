import { useCall } from "./store.ts";

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
        <button type="button" className="btn small" onClick={hangUp}>
          Close
        </button>
      ) : (
        <>
          <button type="button" className="btn small" aria-pressed={muted} onClick={toggleMute}>
            {muted ? "Unmute" : "Mute"}
          </button>
          <button type="button" className="btn small danger" onClick={hangUp}>
            Hang up
          </button>
        </>
      )}
    </section>
  );
}
