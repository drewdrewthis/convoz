import { create } from "zustand";
import { beginGesture, release, type Gesture } from "./gesture.ts";

/** The running call: what the sheet draws. At most one call at a time, in one conversation. */
interface CallState {
  /** The conversation the call is in; null when there is no call. */
  conversation: number | null;
  status: string;
  muted: boolean;
  /** The call is over (the other end closed it, or it could not start); the bar then offers Close. */
  ended: boolean;
  start(conversation: number): void;
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
  conversation: null,
  status: "",
  muted: false,
  ended: false,
  start: (conversation) => {
    if (get().conversation !== null) return;
    // Inside the tap: the audio context and the microphone (gesture.ts). The call's own code loads after.
    const gesture = beginGesture();
    set({ conversation, status: "Connecting…", muted: false, ended: false });
    const control = import("./engine.ts").then((e) =>
      e.runCall({
        conversation,
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
    set({ conversation: null, status: "", ended: false, muted: false });
    if (!call) return;
    release(call.gesture);
    void call.control.then((c) => c.close()).catch(() => {});
  },
}));
