import type { MouseEvent } from "react";

/**
 * keepFocus is the mousedown of every control on the composer: a tap on it must not move focus off the message box. Focus leaving the
 * box reads as "keyboard closed" (keyboard.ts), which re-lays the page out between the press and the release of the tap, and the
 * release then lands on something else (iPhone, owner 2026-10-18: "once you start typing in the input the paperclip stops working").
 */
export const keepFocus = (event: MouseEvent) => event.preventDefault();
