import { IconButton } from "@convoz/ui/IconButton";
import { PhoneIcon } from "@convoz/ui/icons";
import { useEffect } from "react";
import { useCall } from "./store.ts";
import { useVoiceOn } from "./voiceOn.ts";

/**
 * CallButton is Call in the title bar of a conversation, shown only when the server says voice is on. Leaving the page hangs up a call
 * of this conversation; a Now call goes on (CallPill).
 */
export function CallButton({ conversationId }: { conversationId: number }) {
  const on = useVoiceOn();
  const busy = useCall((s) => s.target !== null);
  useEffect(
    () => () => {
      if (useCall.getState().target === conversationId) useCall.getState().hangUp();
    },
    [conversationId],
  );
  if (!on) return null;
  return (
    <IconButton variant="float" label="Call" disabled={busy} onClick={() => useCall.getState().start(conversationId)}>
      <PhoneIcon />
    </IconButton>
  );
}
