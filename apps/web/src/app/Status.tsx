// What the whole app says about itself, on every page: the link is down, with the last time it worked. (A new build needs no note: it
// takes over and reloads the page by itself, sw/index.ts.)
import { clock } from "../shared/chat.ts";
import { useConnection } from "../shared/connection.ts";

export function Status() {
  const offline = useConnection((s) => s.offline);
  const syncedAt = useConnection((s) => s.syncedAt);
  return offline ? (
    <p className="linkbar" role="status">
      Offline{syncedAt ? ` · last synced ${clock(syncedAt)}` : ""}
    </p>
  ) : null;
}
