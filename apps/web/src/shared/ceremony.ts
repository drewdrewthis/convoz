import { useRef, useState, useSyncExternalStore, type MouseEvent } from "react";
import { humanError, page } from "./api.ts";
import type { TicketLike } from "./tickets.ts";

export interface CeremonyOptions {
  /** Where failures show. */
  fail: (message: string) => void;
  /** Another condition the button needs (a valid form). */
  also?: boolean;
  /** false once the place the button lives in is gone (a closed sheet): no more ticket fetches. */
  alive?: () => boolean;
  /** Sees every failure first. */
  onError?: (err: unknown) => void;
}

/**
 * useCeremony wires a button to a ticket: it is disabled while the ticket is not ready or a tap is being handled, and after
 * every try (good or bad) the ticket is fetched again. `go` must call `ticket.use()` before its first await, so the click
 * handler opens the passkey prompt while the tap is fresh. A ticket that went stale before the tap is fetched again and the
 * person is asked to tap once more: a prompt started with options the server forgot would fail late.
 * Spread the result onto the <button>.
 */
export function useCeremony(t: TicketLike, go: () => Promise<void>, o: CeremonyOptions) {
  const ready = useSyncExternalStore(t.subscribe, () => t.ready);
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  const disabled = busy || !ready || o.also === false;
  const onClick = (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    if (running.current || !t.ready || o.also === false) return;
    if (t.stale()) {
      t.refresh();
      o.fail("That passkey check was waiting too long. Tap again when the button is ready.");
      return;
    }
    o.fail("");
    running.current = true;
    setBusy(true);
    const done = go(); // runs synchronously up to its first await: the prompt is already open here
    void done
      .catch((err) => {
        o.onError?.(err);
        o.fail(humanError(err));
      })
      .finally(() => {
        running.current = false;
        setBusy(false);
        if (!t.ready && !page.leaving && (o.alive ? o.alive() : true)) t.refresh();
      });
  };
  return { disabled, "aria-busy": busy, onClick };
}
