// The toast: one short line at the bottom of the screen that goes away by itself (prototype v41, 10 seconds).
import { create } from "zustand";

/** An Undo that reverses only what the toast announced. */
export type Undo = () => void | Promise<void>;

interface ToastState {
  text: string;
  /** The Undo button's action; null for a plain toast. */
  undo: Undo | null;
  /** Bumped by every toast, so the same words twice restart the clock. */
  n: number;
}

export const useToast = create<ToastState>()(() => ({ text: "", undo: null, n: 0 }));

let timer: ReturnType<typeof setTimeout> | undefined;

/** toast shows `text` for ten seconds, in place of the one before it. With `undo` it carries an Undo button. */
export function toast(text: string, undo?: Undo): void {
  clearTimeout(timer);
  useToast.setState((s) => ({ text, undo: undo ?? null, n: s.n + 1 }));
  timer = setTimeout(() => useToast.setState({ text: "", undo: null }), 10_000);
}

/** runUndo takes the toast down and runs what it offered. */
export function runUndo(): void {
  const { undo } = useToast.getState();
  clearTimeout(timer);
  useToast.setState({ text: "", undo: null });
  if (undo) void undo();
}
