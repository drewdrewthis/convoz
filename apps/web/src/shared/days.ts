// Days in a conversation, in the browser's time zone (owner-approved UX plan: day separators, conv messages 4343/4350).

const DAY_MS = 86_400_000;

/** startOfDay is the start of the local day of a time, in ms: two times are on one day when this is equal. */
export const startOfDay = (ms: number): number => new Date(ms).setHours(0, 0, 0, 0);

let weekdayFormat: Intl.DateTimeFormat | undefined;
let monthFormat: Intl.DateTimeFormat | undefined;
let fullFormat: Intl.DateTimeFormat | undefined;

/**
 * dayOf is the day label of the message list: "Today", "Yesterday", "Wed 21 Oct", and "Wed 21 Oct 2025" for another year.
 * Days are counted in whole local days (round: a day with a daylight-saving change is 23 or 25 hours long).
 */
export function dayOf(ms: number, now: number): string {
  const days = Math.round((startOfDay(now) - startOfDay(ms)) / DAY_MS);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  const d = new Date(ms);
  weekdayFormat ??= new Intl.DateTimeFormat("en-GB", { weekday: "short" });
  monthFormat ??= new Intl.DateTimeFormat("en-GB", { month: "short" });
  const base = `${weekdayFormat.format(d)} ${d.getDate()} ${monthFormat.format(d)}`;
  return d.getFullYear() === new Date(now).getFullYear() ? base : `${base} ${d.getFullYear()}`;
}

/** fullDate is the whole local date and time of a message, for the hover on its time: "Friday, October 23, 2026 at 5:24 PM" in en-US. */
export function fullDate(ms: number): string {
  fullFormat ??= new Intl.DateTimeFormat(undefined, { dateStyle: "full", timeStyle: "short" });
  return fullFormat.format(ms);
}
