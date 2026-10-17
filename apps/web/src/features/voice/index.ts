// Voice: recording a voice note (MediaRecorder, waveform) and playing one. It draws inside the composer and a conversation, not at
// a URL of its own. Both parts load on first use, so neither is in the first load (design §12.2).
import { lazy } from "react";

export type { VoiceRecording } from "./recorder.tsx";

/** loadRecorder loads the recorder on the first tap of the microphone. */
export const loadRecorder = () => import("./recorder.tsx");

/** VoiceNote is the voice bubble of a message: play, waveform, length and transcript. */
export const VoiceNote = lazy(() => import("./VoiceNote.tsx").then((m) => ({ default: m.VoiceNote })));
