/** Start of the local day of a time, in ms. */
const startOf = (ms: number) => new Date(ms).setHours(0, 0, 0, 0);

/**
 * dayOf is the day label of the message list, in the local time zone: "Today", "Yesterday", "Wed 21 Oct", and "Wed 21 Oct 2025" for
 * another year (owner-approved UX plan, conv messages 4343/4350).
 */
export function dayOf(ms: number, now: number): string {
  const days = Math.round((startOf(now) - startOf(ms)) / 86_400_000);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  const d = new Date(ms);
  const base = `${d.toLocaleDateString("en-GB", { weekday: "short" })} ${d.getDate()} ${d.toLocaleDateString("en-GB", { month: "short" })}`;
  return d.getFullYear() === new Date(now).getFullYear() ? base : `${base} ${d.getFullYear()}`;
}
