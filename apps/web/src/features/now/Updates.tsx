import type { ShippedDelivery } from "@convoz/api-client";
import { Button } from "@convoz/ui/Button";
import { useEffect, useState } from "react";
import { useDeliveries } from "../delivery/index.ts";
import { ItemFrame } from "./ItemFrame.tsx";

// STOPGAP: "Got it" is kept on this device only (localStorage). The server has no acknowledge state for a plan event yet; when it does,
// this key goes and the server's state replaces it.
const KEY = "convoz.now.acked";

const keyOf = (d: ShippedDelivery) => `${d.conversation_id}:${d.handle}:${d.at}:${d.text}`;
const read = (): string[] => {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
};

/** startOfToday is local midnight on the server's clock, as epoch ms. */
const startOfToday = (now: number) => new Date(new Date(now).setHours(0, 0, 0, 0)).getTime();

/** useUpdates are the deliverables done today that the owner has not acknowledged on this device, newest first. */
export function useUpdates(): { list: ShippedDelivery[]; ack: (d: ShippedDelivery) => void } {
  useEffect(() => useDeliveries.getState().ensure(), []);
  const data = useDeliveries((s) => s.data);
  const [acked, setAcked] = useState(read);
  const cut = startOfToday(data?.now ?? Date.now());
  const list = (data?.shipped ?? []).filter((d) => d.at >= cut && !acked.includes(keyOf(d))).sort((a, b) => b.at - a.at);
  const ack = (d: ShippedDelivery) => {
    const next = [...read(), keyOf(d)].slice(-200);
    try {
      localStorage.setItem(KEY, JSON.stringify(next));
    } catch {
      // A full or blocked store: the update goes for this session only.
    }
    setAcked(next);
  };
  return { list, ack };
}

/** Updates is the Updates section of Now: a plan step that moved or finished. The frame is the Needs you frame; the action is Got it. */
export function Updates({ list, ack, current }: { list: ShippedDelivery[]; ack: (d: ShippedDelivery) => void; current: number }) {
  if (!list.length) return null;
  return (
    <section id="updates" className="mb-8 flex flex-col gap-8" aria-label="Updates">
      <p className="ghdr">{`Updates · ${list.length}`}</p>
      {list.map((d) => (
        <div key={keyOf(d)} aria-current={d.conversation_id === current ? "page" : undefined}>
          <ItemFrame
            kind="update"
            title={`${d.text} — done`}
            context={`@${d.handle} finished this at ${new Date(d.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`}
            from={{ id: d.conversation_id, title: d.title }}
            actions={
              <Button variant="primary" size="inline" className="mr-8 ml-8" onClick={() => ack(d)}>
                Got it
              </Button>
            }
          />
        </div>
      ))}
    </section>
  );
}
