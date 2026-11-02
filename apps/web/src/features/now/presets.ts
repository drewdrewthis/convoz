import type { SnoozePreset } from "@convoz/app-kit";

/** The hour of the day from which "Tonight" (6:00 PM, prototype v41) is over (design §8.1). */
const TONIGHT_ENDS = 18;

/** presetsAt lists the snooze choices at a moment, in the reader's time zone: "Tonight" is not offered from 20:00. */
export function presetsAt(at: number): SnoozePreset[] {
  const late = new Date(at).getHours() >= TONIGHT_ENDS;
  return [{ key: "1h", label: "1 hour" }, ...(late ? [] : [{ key: "tonight", label: "Tonight" }]), { key: "tomorrow", label: "Tomorrow" }];
}

/** The hour of the day a "Tomorrow" or "Next week" Later wakes the card, in the reader's time zone. */
const LATER_AT = 9;

/** A Later choice: its menu label and the absolute time the server is sent (epoch ms). */
export interface LaterOption {
  label: string;
  until: number;
}

/** laterOptionsAt lists the choices of Later on a mention card at a moment: 1 hour, tomorrow 9:00 and next Monday 9:00, in the reader's zone. */
export function laterOptionsAt(at: number): LaterOption[] {
  const from = new Date(at);
  const nineOn = (days: number) => new Date(from.getFullYear(), from.getMonth(), from.getDate() + days, LATER_AT).getTime();
  const untilMonday = ((8 - from.getDay()) % 7) || 7;
  return [
    { label: "1 hour", until: at + 3_600_000 },
    { label: "Tomorrow 9:00", until: nineOn(1) },
    { label: "Next week", until: nineOn(untilMonday) },
  ];
}
