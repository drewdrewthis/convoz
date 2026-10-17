// The toast: one short line at the bottom of the screen that goes away by itself (prototype v41, 10 seconds).
import { create } from "zustand";

interface ToastState {
  text: string;
  /** Bumped by every toast, so the same words twice restart the clock. */
  n: number;
}

export const useToast = create<ToastState>()(() => ({ text: "", n: 0 }));

let timer: ReturnType<typeof setTimeout> | undefined;

/** toast shows `text` for ten seconds, in place of the one before it. */
export function toast(text: string): void {
  clearTimeout(timer);
  useToast.setState((s) => ({ text, n: s.n + 1 }));
  timer = setTimeout(() => useToast.setState({ text: "" }), 10_000);
}
