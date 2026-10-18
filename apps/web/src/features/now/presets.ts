import type { SnoozePreset } from "@convoz/app-kit";

/** The hour of the day from which "Tonight" (6:00 PM, prototype v41) is over (design §8.1). */
const TONIGHT_ENDS = 18;

/** presetsAt lists the snooze choices at a moment, in the reader's time zone: "Tonight" is not offered from 20:00. */
export function presetsAt(at: number): SnoozePreset[] {
  const late = new Date(at).getHours() >= TONIGHT_ENDS;
  return [{ key: "1h", label: "1 hour" }, ...(late ? [] : [{ key: "tonight", label: "Tonight" }]), { key: "tomorrow", label: "Tomorrow" }];
}
