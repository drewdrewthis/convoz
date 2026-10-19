/** What the tap hands to the call: the audio context and the microphone, both asked for inside the tap itself. */
export interface Gesture {
  ctx: AudioContext;
  mic: Promise<MediaStream>;
}

interface AudioSessionNavigator {
  audioSession?: { type: string };
}

/**
 * beginGesture must run synchronously in the tap handler: iOS lets audio start only from a tap. It makes the audio context at the
 * device's own rate and resumes it, tells iOS the page both plays and records (so the speaker is not muted), and asks for the
 * microphone with echo cancellation. Nothing here waits on the network; the token is fetched after.
 */
export function beginGesture(): Gesture {
  const Context = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const ctx = new Context();
  void ctx.resume();
  const session = (navigator as AudioSessionNavigator).audioSession;
  if (session) session.type = "play-and-record";
  const mic = navigator.mediaDevices?.getUserMedia
    ? navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } })
    : Promise.reject(new Error("no microphone"));
  mic.catch(() => {}); // the call reports it; this keeps a hang-up before the answer from being an unhandled rejection
  return { ctx, mic };
}

/** release stops everything a gesture opened. */
export function release(g: Gesture): void {
  void g.mic.then((s) => s.getTracks().forEach((t) => t.stop())).catch(() => {});
  void g.ctx.close().catch(() => {});
}
