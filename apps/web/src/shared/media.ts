// Whether images, audio, unfurl cards and app previews load by themselves (design §12.3). On a link that asked to save data, or a
// slow one, they show a placeholder with their size and "tap to load" instead. The owner can force it either way in Settings →
// Advanced; the choice belongs to this device.
import { effectiveType } from "./connection.ts";

export type MediaAutoload = "auto" | "on" | "off";
const KEY = "convoz.media_autoload";
const SLOW = new Set(["slow-2g", "2g", "3g"]);

/** mediaSetting is the owner's choice for this device ("auto" until they pick). */
export function mediaSetting(): MediaAutoload {
  try {
    const v = localStorage.getItem(KEY);
    return v === "on" || v === "off" ? v : "auto";
  } catch {
    return "auto";
  }
}

/** chooseMedia saves the choice. */
export function chooseMedia(value: MediaAutoload): void {
  try {
    localStorage.setItem(KEY, value);
  } catch {
    /* a private window: the choice lasts until the page closes */
  }
}

/** mediaAutoLoads says whether media should load without a tap right now. */
export function mediaAutoLoads(): boolean {
  const setting = mediaSetting();
  if (setting !== "auto") return setting === "on";
  const link = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection;
  return !link?.saveData && !SLOW.has(effectiveType());
}
