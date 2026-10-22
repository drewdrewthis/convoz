import { CallControls } from "./CallBar.tsx";
import { CallTimer } from "./CallTimer.tsx";
import { useCall } from "./store.ts";

/**
 * CallPill is a Now call on a page of the shell: a bar in the page's own flow, between the content and the tab bar, so it never covers
 * anything. The shell draws it on every page (app/frames.tsx); a conversation shows the call in its CallBar instead. The call lives
 * in the store, so the pill drawn on the next page shows the same call.
 */
export function CallPill() {
  const target = useCall((s) => s.target);
  if (target !== "now") return null;
  return (
    <section className="callpill" aria-label="Call">
      <CallControls>
        <CallTimer />
      </CallControls>
    </section>
  );
}
