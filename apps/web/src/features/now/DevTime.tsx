import { useEffect, useState } from "react";
import { whenLabel } from "../../shared/chat.ts";
import { fullDate } from "../../shared/days.ts";
import { ago } from "./Unread.tsx";

/** ItemTime is when an item last changed: "5m", "2h" under a day, then Yesterday or a date (the main app's `ago` and `whenLabel`), with the exact time on hover. It redraws every 30 s. */
export function ItemTime({ at }: { at: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  return (
    <time className="text-12 font-normal text-muted" dateTime={new Date(at).toISOString()} title={fullDate(at)}>
      {now - at < 86_400_000 ? ago(at, now) : whenLabel(at)}
    </time>
  );
}
