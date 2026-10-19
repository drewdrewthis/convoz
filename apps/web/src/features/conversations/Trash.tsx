import type { Conversation } from "@convoz/api-client";
import { useCallback, useEffect, useState } from "react";
import { call, client, humanError } from "../../shared/api.ts";
import { stripCf } from "../../shared/chat.ts";
import { useNotice } from "../../shared/notice.tsx";
import { restore } from "./actions.ts";
import { Button } from "@convoz/ui/Button";
import { EmptyState } from "@convoz/ui/EmptyState";
import { List, ListRow } from "@convoz/ui/ListRow";

const DAY = 86_400_000;

/** forever says when the trash empties a conversation: "deleted forever in 30 days". */
export function forever(purgesAt: number, now = Date.now()): string {
  const days = Math.max(Math.ceil((purgesAt - now) / DAY), 0);
  return days === 0 ? "deleted forever today" : `deleted forever in ${days} ${days === 1 ? "day" : "days"}`;
}

/** Trash is /trash: the deleted conversations, each with a Restore button. */
export function Trash() {
  const { fail } = useNotice();
  const [rows, setRows] = useState<Conversation[] | null>(null);
  const load = useCallback(async () => {
    try {
      setRows((await call(client.GET("/api/conversations", { params: { query: { deleted: "1" } } }))).conversations);
    } catch (err) {
      fail(humanError(err));
    }
  }, [fail]);
  useEffect(() => void load(), [load]);

  const back = async (c: Conversation) => {
    try {
      await restore(c.id);
      await load();
    } catch (err) {
      fail(humanError(err));
    }
  };
  return (
    <div id="trash" className="trash" aria-busy={rows === null ? true : undefined}>
      {rows && rows.length === 0 ? <EmptyState>Trash is empty. A deleted conversation waits here for 30 days.</EmptyState> : null}
      <List role="list" aria-label="Trash" hidden={!rows?.length}>
        {(rows ?? []).map((c) => (
          <ListRow
            key={c.id}
            title={stripCf(c.title ?? "") || "New conversation"}
            sub={c.purges_at ? forever(c.purges_at) : ""}
            trailing={
              <Button className="flex-none" size="small" aria-label={`Restore ${stripCf(c.title ?? "") || "New conversation"}`} onClick={() => void back(c)}>
                Restore
              </Button>
            }
          />
        ))}
      </List>
    </div>
  );
}
