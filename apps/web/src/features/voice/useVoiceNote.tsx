import type { Upload } from "@convoz/api-client";
import { useRef, useState, type ReactNode, type RefObject } from "react";
import { micNote, RecorderLoadError } from "./micNote.ts";
import type { VoiceRecording } from "./recorder.tsx";

/** loadRecorder loads the recorder on the first tap of the microphone. */
export const loadRecorder = () => import("./recorder.tsx");

type Recorder = Awaited<ReturnType<typeof loadRecorder>>;

export interface VoiceNoteControl {
  /** Put on the microphone button, so focus comes back to it when the recording ends. */
  mic: RefObject<HTMLButtonElement | null>;
  /** Start recording (the microphone button's click). */
  start(): void;
  /** True while the recording bar is up; the box it replaces should be hidden. */
  recording: boolean;
  /** The recording bar while recording, nothing otherwise. */
  bar: ReactNode;
  /** Why the recording could not start, as a line under the box; null when there is nothing to say. */
  note: ReactNode;
  /** Clear the note (the owner started typing). */
  clearNote(): void;
}

/**
 * useVoiceNote is the microphone of a message box, shared by the main composer and the thread reply box: tap to record, the bar
 * takes the box's place, and `onSent` gets the finished upload after Send (nothing after Cancel).
 */
export function useVoiceNote(conversationId: number, onSent: (upload: Upload) => void): VoiceNoteControl {
  const [voice, setVoice] = useState<{ Bar: Recorder["RecordingBar"]; recording: VoiceRecording } | null>(null);
  const [error, setError] = useState("");
  const mic = useRef<HTMLButtonElement>(null);
  const starting = useRef(false);

  const start = async () => {
    if (starting.current) return; // a second tap while the microphone prompt is open
    starting.current = true;
    setError("");
    try {
      const recorder = await loadRecorder().catch(() => Promise.reject(new RecorderLoadError())); // the recorder's code loads on the first tap
      setVoice({ Bar: recorder.RecordingBar, recording: await recorder.startRecording(conversationId) });
    } catch (err) {
      setError(micNote(err));
    } finally {
      starting.current = false;
    }
  };
  const end = (sent?: Upload) => {
    setVoice(null);
    if (sent) onSent(sent);
    requestAnimationFrame(() => mic.current?.focus());
  };

  return {
    mic,
    start: () => void start(),
    recording: Boolean(voice),
    bar: voice ? <voice.Bar recording={voice.recording} onDone={end} /> : null,
    note: error ? (
      <p role="alert" className="micnote">
        {error}
      </p>
    ) : null,
    clearNote: () => setError(""),
  };
}
