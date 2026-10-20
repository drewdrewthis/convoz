// Call: talking to the agents of a conversation by voice (Gemini Live). The button and the bar are small; the call itself (the
// microphone worklet, the model's SDK) loads on the first tap (design §12.2). The phone talks to Google directly with a one-use token.
export { CallBar } from "./CallBar.tsx";
export { CallButton } from "./CallButton.tsx";
export { CallLogRow } from "./CallLogRow.tsx";
export { splitCallLog } from "./log.ts";
export { ViaVoiceMark } from "./ViaVoiceMark.tsx";
import "./call.css";
