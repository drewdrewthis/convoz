import { CHROME_IOS_HINT, isChromeOnIOS } from "../notifications/index.ts";

/** Thrown by the recorder when the browser has no microphone API or no MediaRecorder at all. */
export class NoRecorderApiError extends Error {}

/** Thrown by the composer when the recorder's code could not be loaded (offline, or a stale page after a deploy). */
export class RecorderLoadError extends Error {}

/** micNote turns why the recording could not start into what the owner reads under the composer. */
export function micNote(err: unknown): string {
  if (err instanceof RecorderLoadError) return "Could not load the recorder. Reload Convoz and try again.";
  if (err instanceof NoRecorderApiError) return isChromeOnIOS() ? `Chrome on iPhone can't use the microphone here. ${CHROME_IOS_HINT}` : "This browser can't record audio.";
  if ((err as { name?: string } | null)?.name === "NotAllowedError") return "Microphone access is off. Allow it in Settings for this app, then try again.";
  return "The microphone is not available.";
}
