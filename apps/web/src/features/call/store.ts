import { create } from "zustand";
import { beginGesture, release, type Gesture } from "./gesture.ts";

/** Where a call is aimed: Now, the triage call and the default (it reads what waits for the owner), or one conversation (its id). */
export type CallTarget = number | "now";

/** The running call: what the bar and the pill draw. At most one call at a time. */
interface CallState {
  /** What the call is aimed at; null when there is no call. */
  target: CallTarget | null;
  /** When the call started (epoch ms), for the pill's clock. */
  startedAt: number;
  status: string;
  muted: boolean;
  /** The call is over (the other end closed it, or it could not start); the bar then offers Close. */
  ended: boolean;
  /** Start a call; with no target it is the triage call. */
  start(target?: CallTarget): void;
  toggleMute(): void;
  /** Hang up: close the connection and the microphone and take the bar away. */
  hangUp(): void;
}

interface Control {
  close(): void;
  mute(on: boolean): void;
}

let running: { gesture: Gesture; control: Promise<Control> } | null = null;

export const useCall = create<CallState>((set, get) => ({
  target: null,
  startedAt: 0,
  status: "",
  muted: false,
  ended: false,
  start: (target = "now") => {
    if (get().target !== null) return;
    // Inside the tap: the audio context and the microphone (gesture.ts). The call's own code loads after.
    const gesture = beginGesture();
    set({ target, startedAt: Date.now(), status: "Connecting…", muted: false, ended: false });
    const control = import("./engine.ts").then((e) =>
      e.runCall({
        target,
        gesture,
        say: (status) => set({ status }),
        over: (status) => set({ status, ended: true }),
      }),
    );
    running = { gesture, control };
    control.catch(() => set({ status: "The call could not start.", ended: true })); // the engine's code did not load
  },
  toggleMute: () => {
    const muted = !get().muted;
    set({ muted });
    void running?.control.then((c) => c.mute(muted)).catch(() => {});
  },
  hangUp: () => {
    const call = running;
    running = null;
    set({ target: null, startedAt: 0, status: "", ended: false, muted: false });
    if (!call) return;
    release(call.gesture);
    void call.control.then((c) => c.close()).catch(() => {});
  },
}));

/** startNowCall starts the triage call, the default call. Call it inside the tap (gesture.ts). */
export const startNowCall = (): void => useCall.getState().start();

/** nowCallLive says whether a Now call is on: then a link of the app must not load a new document, which would end it. */
export const nowCallLive = (): boolean => useCall.getState().target === "now";
