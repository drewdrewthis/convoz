// What the whole app says about itself, on every page: the link is down (with the last time it worked), and an update waits.
import { clock } from "../shared/chat.ts";
import { useConnection } from "../shared/connection.ts";
import { applyUpdate, useUpdate } from "../sw/index.ts";

export function Status() {
  const offline = useConnection((s) => s.offline);
  const syncedAt = useConnection((s) => s.syncedAt);
  const update = useUpdate((s) => s.ready);
  return (
    <>
      {offline ? (
        <p className="linkbar" role="status">
          Offline{syncedAt ? ` · last synced ${clock(syncedAt)}` : ""}
        </p>
      ) : null}
      {update ? (
        <p className="updatebar glass" role="status">
          Update ready ·{" "}
          <button type="button" onClick={applyUpdate}>
            Reload
          </button>
        </p>
      ) : null}
    </>
  );
}
