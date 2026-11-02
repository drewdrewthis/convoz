// Call: talking to the agents of a conversation by voice (Gemini Live), or a triage call from anywhere that reads Now. The button, the
// bar and the pill are small; the call itself (the microphone worklet, the model's SDK) loads on the first tap (design §12.2). The
// phone talks to Google directly with a one-use token.
export { CallBar } from "./CallBar.tsx";
export { CallButton } from "./CallButton.tsx";
export { CallLogRow } from "./CallLogRow.tsx";
export { CallPill } from "./CallPill.tsx";
export { splitCallLog } from "./log.ts";
export { sendKeptLogs } from "./pendingLog.ts";
export { nowCallLive, startNowCall } from "./store.ts";
export { ViaVoiceMark } from "./ViaVoiceMark.tsx";
export { useVoiceOn } from "./voiceOn.ts";
import "./call.css";
