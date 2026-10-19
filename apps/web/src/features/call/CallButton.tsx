import { PhoneIcon } from "@convoz/ui/icons";
import { useEffect } from "react";
import { useCall } from "./store.ts";
import { useVoiceOn } from "./voiceOn.ts";

/** CallButton is Call in the title bar of a conversation, shown only when the server says voice is on. Leaving the page hangs up. */
export function CallButton({ conversationId }: { conversationId: number }) {
  const on = useVoiceOn();
  const busy = useCall((s) => s.conversation !== null);
  useEffect(
    () => () => {
      if (useCall.getState().conversation === conversationId) useCall.getState().hangUp();
    },
    [conversationId],
  );
  if (!on) return null;
  return (
    <button type="button" className="iconbtn" aria-label="Call" title="Call" disabled={busy} onClick={() => useCall.getState().start(conversationId)}>
      <PhoneIcon />
    </button>
  );
}
