import { isPhone } from "../../shared/api.ts";

/** The least a keyboard takes off the visible height, in px: less is a browser toolbar sliding away, not a keyboard. */
const KEYBOARD_MIN = 80;

/** The part of the VirtualKeyboard API the page reads (Chromium on Android; absent on iOS Safari, where the visual viewport says it all). */
interface VirtualKeyboard extends EventTarget {
  boundingRect: DOMRectReadOnly;
}

export const virtualKeyboard = (): VirtualKeyboard | undefined => (navigator as Navigator & { virtualKeyboard?: VirtualKeyboard }).virtualKeyboard;

const EDITABLE = "textarea, input:not([type=checkbox]):not([type=radio]):not([type=file]):not([type=button]), [contenteditable=''], [contenteditable='true']";

/** The tallest visible height seen at one width: the screen with no keyboard on it. */
export interface Screen {
  width: number;
  height: number;
}

/**
 * keyboardOpen says whether a phone's on-screen keyboard is up: a text field has focus and the visible height lost at least
 * KEYBOARD_MIN of the screen, or the VirtualKeyboard API reports a keyboard. The visual viewport shrinks on iOS while the layout
 * viewport stays; with `interactive-widget=resizes-content` (Android Chrome) both shrink, so the full height is remembered in
 * `screen` (updated while nothing is being typed, and renewed when the width changes with a turn of the phone).
 */
export function keyboardOpen(vv: VisualViewport, screen: Screen): boolean {
  // A tap on a control of the message box (Attach, Send) moves focus to it for a moment while the keyboard is still up.
  const typing = Boolean(document.activeElement?.closest(`${EDITABLE}, .compose`));
  if (innerWidth !== screen.width) {
    screen.width = innerWidth;
    screen.height = 0;
  }
  if (!typing) screen.height = Math.max(screen.height, innerHeight, vv.height);
  if (!isPhone() || !typing) return false;
  return (virtualKeyboard()?.boundingRect.height ?? 0) > 0 || Math.max(screen.height, innerHeight) - vv.height >= KEYBOARD_MIN;
}
