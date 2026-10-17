// Whether images, audio, unfurl cards and app previews load by themselves (design §12.3). On a link that asked to save data, or a
// slow one, they show a placeholder with their size and "tap to load" instead. The owner can force it either way in Settings →
// Advanced; the choice belongs to this device.
import { useEffect } from "react";
import { effectiveType, median, useConnection } from "./connection.ts";
import { ping } from "./ping.ts";

export type MediaAutoload = "auto" | "on" | "off";
const KEY = "convoz.media_autoload";
const SLOW = new Set(["slow-2g", "2g", "3g"]);
/** Where the browser has no Network Information API (iOS Safari) the app judges the link by its own pings: a median above this is slow. */
const SLOW_RTT_MS = 300;
/** Pings taken for that judgement, and how many of the newest the median reads. */
const PROBES = 3;
const WINDOW = 5;

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

const saveData = (): boolean => Boolean((navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData);

/** The browser names no connection type: our own pings have to say how the link is. */
const measured = (): boolean => effectiveType() === "unknown";

/**
 * mediaAutoLoads says whether media should load without a tap right now. `samples` are the round trips measured so far; on a browser
 * with no connection type the link counts as slow until enough of them say otherwise.
 */
export function mediaAutoLoads(samples: number[] = useConnection.getState().samples): boolean {
  const setting = mediaSetting();
  if (setting !== "auto") return setting === "on";
  if (saveData()) return false;
  if (!measured()) return !SLOW.has(effectiveType());
  const recent = samples.slice(-WINDOW);
  return recent.length >= PROBES && median(recent) <= SLOW_RTT_MS;
}

let probing = false;
/** probeLink takes the first pings for a browser that cannot say how fast its link is. Once per page: the samples stay. */
async function probeLink(): Promise<void> {
  if (probing) return;
  probing = true;
  for (let n = 0; n < PROBES; n++) await ping();
  probing = false;
}

/** useMediaAutoLoads is mediaAutoLoads for a view: it answers again as pings come in. */
export function useMediaAutoLoads(): boolean {
  const samples = useConnection((s) => s.samples);
  const waiting = mediaSetting() === "auto" && !saveData() && measured() && samples.length < PROBES;
  useEffect(() => {
    if (waiting) void probeLink();
  }, [waiting]);
  return mediaAutoLoads(samples);
}
