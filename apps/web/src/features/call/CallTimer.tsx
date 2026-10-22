import { useEffect, useState } from "react";
import { useCall } from "./store.ts";

const clock = (ms: number): string => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

/** CallTimer is the time on the call, "m:ss", ticking each second until the call is over. */
export function CallTimer() {
  const startedAt = useCall((s) => s.startedAt);
  const ended = useCall((s) => s.ended);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (ended) return;
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(tick);
  }, [ended]);
  return (
    <span role="timer" className="calltime" aria-label="Time on the call">
      {clock(now - startedAt)}
    </span>
  );
}
