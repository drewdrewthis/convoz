// The installed app's icon badge: while the page is in the background it shows how many asks wait (not the snoozed ones).
import { useNow } from "./store.ts";

type Badging = Navigator & { setAppBadge?: (n?: number) => Promise<void>; clearAppBadge?: () => Promise<void> };

function sync(): void {
  const nav = navigator as Badging;
  const count = useNow.getState().now?.badge ?? 0;
  const hidden = document.hidden || document.visibilityState === "hidden";
  const set = hidden && count > 0 ? nav.setAppBadge?.(count) : nav.clearAppBadge?.();
  set?.catch(() => {});
}

useNow.subscribe(sync);
document.addEventListener("visibilitychange", sync);
