/**
 * isTouchPhone is true on a device whose main pointer is a finger and that cannot hover: a phone or a tablet, not a narrow desktop
 * window (isPhone in api.ts is true for both). There news is a push, not a toast (owner, conv 179 msg 14826).
 */
export const isTouchPhone = (): boolean => typeof matchMedia === "function" && matchMedia("(hover: none) and (pointer: coarse)").matches;
