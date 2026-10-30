// The toast: one short line at the bottom of the screen that goes away by itself (prototype v41, 10 seconds).
import { create } from "zustand";

/** An Undo that reverses only what the toast announced. */
export type Undo = () => void | Promise<void>;

interface ToastState {
  text: string;
  /** The Undo button's action; null for a plain toast. */
  undo: Undo | null;
  /** The button's words: Undo, or what the action does ("Open"). */
  label: string;
  /** Bumped by every toast, so the same words twice restart the clock. */
  n: number;
}

export const useToast = create<ToastState>()(() => ({ text: "", undo: null, label: "Undo", n: 0 }));

let timer: ReturnType<typeof setTimeout> | undefined;

/** toast shows `text` for ten seconds, in place of the one before it. With `undo` it carries a button, named `label`. */
export function toast(text: string, undo?: Undo, label = "Undo"): void {
  clearTimeout(timer);
  useToast.setState((s) => ({ text, undo: undo ?? null, label, n: s.n + 1 }));
  timer = setTimeout(() => useToast.setState({ text: "", undo: null }), 10_000);
}

/** runUndo takes the toast down and runs what it offered. */
export function runUndo(): void {
  const { undo } = useToast.getState();
  clearTimeout(timer);
  useToast.setState({ text: "", undo: null });
  if (undo) void undo();
}
