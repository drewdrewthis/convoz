// Voice: recording a voice note (MediaRecorder, waveform) and playing one. It draws inside the composer and a conversation, not at
// a URL of its own. Both parts load on first use, so neither is in the first load (design §12.2).
import { lazy } from "react";

export type { VoiceRecording } from "./recorder.tsx";
export { micNote, RecorderLoadError } from "./micNote.ts";

/** VoiceNote is the voice bubble of a message: play, waveform, length and transcript. */
export const VoiceNote = lazy(() => import("./VoiceNote.tsx").then((m) => ({ default: m.VoiceNote })));

export { loadRecorder, useVoiceNote, type VoiceNoteControl } from "./useVoiceNote.tsx";
