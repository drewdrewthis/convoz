import { useEffect, useState } from "react";
import { useDeliveries } from "../delivery/index.ts";

// STOPGAP: "Got it" is kept on this device only (localStorage). The server has no acknowledge state for a plan event yet; when it does,
// this key goes and the server's state replaces it.
const KEY = "convoz.now.acked";

/** One fyi item: a plan step the agent started today, or finished today. One row per step: the latest state wins. */
export interface Fyi {
  /** conversation + agent + step text: the same step is the same row as it moves from started to done. */
  step: string;
  state: "started" | "done";
  conversation_id: number;
  title: string;
  handle: string;
  text: string;
  at: number;
}

const read = (): string[] => {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
};

/** ackKey names one state of one step: moving to the next state is news again, so it needs a new Got it. */
export const ackKey = (f: Fyi): string => `${f.step}:${f.state}:${f.at}`;

/** startOfToday is local midnight on the server's clock, as epoch ms. */
const startOfToday = (now: number) => new Date(new Date(now).setHours(0, 0, 0, 0)).getTime();

/** useUpdates are the fyi items of Now: steps started or done today that the owner has not acknowledged on this device, newest first. */
export function useUpdates(): { list: Fyi[]; ack: (f: Fyi) => void } {
  useEffect(() => useDeliveries.getState().ensure(), []);
  const data = useDeliveries((s) => s.data);
  const [acked, setAcked] = useState(read);
  const cut = startOfToday(data?.now ?? Date.now());
  const rows = new Map<string, Fyi>();
  // What the agents are doing: the step's own start, else when the plan was last set.
  for (const d of data?.deliveries ?? []) {
    for (const it of d.doing) {
      const at = it.since ?? d.plan_updated_at;
      if (at >= cut) rows.set(`${d.conversation_id}:${d.handle}:${it.text}`, { step: `${d.conversation_id}:${d.handle}:${it.text}`, state: "started", conversation_id: d.conversation_id, title: d.title, handle: d.handle, text: it.text, at });
    }
  }
  // A step that is done replaces its started row.
  for (const s of data?.shipped ?? []) {
    if (s.at < cut) continue;
    const step = `${s.conversation_id}:${s.handle}:${s.text}`;
    rows.set(step, { step, state: "done", conversation_id: s.conversation_id, title: s.title, handle: s.handle, text: s.text, at: s.at });
  }
  const list = [...rows.values()].filter((f) => !acked.includes(ackKey(f))).sort((a, b) => b.at - a.at);
  const ack = (f: Fyi) => {
    const next = [...read(), ackKey(f)].slice(-200);
    try {
      localStorage.setItem(KEY, JSON.stringify(next));
    } catch {
      // A full or blocked store: the update goes for this session only.
    }
    setAcked(next);
  };
  return { list, ack };
}
