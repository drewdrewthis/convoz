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
/** The newest news that came while an Undo showed; it shows when that toast ends. */
let held: Parameters<typeof toast> | null = null;

/** toast shows `text` for ten seconds, in place of the one before it. With `undo` it carries a button, named `label`. */
export function toast(text: string, undo?: Undo, label = "Undo"): void {
  clearTimeout(timer);
  useToast.setState((s) => ({ text, undo: undo ?? null, label, n: s.n + 1 }));
  timer = setTimeout(end, 10_000);
}

/**
 * notify is toast for news the owner did not cause (a new message, an ask, a connect request). It does not replace a live Undo,
 * whose action would be lost: it waits until that toast ends or is used, and only the newest news waits.
 */
export function notify(text: string, action?: Undo, label = "Undo"): void {
  const { undo, label: now } = useToast.getState();
  if (undo && now === "Undo") held = [text, action, label];
  else toast(text, action, label);
}

/** end takes the toast down and shows the news held behind it, if any. */
function end(): void {
  clearTimeout(timer);
  useToast.setState({ text: "", undo: null });
  const next = held;
  held = null;
  if (next) toast(...next);
}

/** runUndo takes the toast down and runs what it offered. */
export function runUndo(): void {
  const { undo } = useToast.getState();
  end();
  if (undo) void undo();
}
