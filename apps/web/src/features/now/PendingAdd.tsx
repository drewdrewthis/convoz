import type { NowPendingAdd } from "@convoz/api-client";
import { whoLine } from "@convoz/app-kit";
import { Button } from "@convoz/ui/Button";
import { useId, useState } from "react";
import { call, client, humanError } from "../../shared/api.ts";
import { useNotice } from "../../shared/notice.tsx";

/** PendingAdd is an agent asking to bring another one into a conversation, or to join one itself; the owner decides here or in the conversation. */
export function PendingAdd({ add, reload }: { add: NowPendingAdd; reload: () => Promise<void> }) {
  const { fail } = useNotice();
  const id = useId();
  const [working, setWorking] = useState(false);
  const who = add.requested_by ? whoLine(add.requested_by) : "An agent";
  const selfAsk = add.requested_by?.handle === add.person.handle;
  const decide = async (approve: boolean) => {
    setWorking(true);
    try {
      const path = approve ? "/api/conversations/{id}/participants/{iid}/approve" : "/api/conversations/{id}/participants/{iid}/decline";
      await call(client.POST(path, { params: { path: { id: add.conversation.id, iid: add.person.id! } }, body: {} }));
      await reload();
    } catch (err) {
      fail(humanError(err));
      setWorking(false);
    }
  };
  return (
    <article className="card" aria-labelledby={id}>
      <h3 id={id}>{selfAsk ? `${who} wants to join` : `${who} wants to add ${whoLine(add.person)}`}</h3>
      <p className="text-13 text-muted">{add.conversation.title || "Untitled conversation"}</p>
      <div className="btns">
        <Button variant="primary" disabled={working} onClick={() => void decide(true)}>
          Approve
        </Button>
        <Button disabled={working} onClick={() => void decide(false)}>
          {selfAsk ? "Deny" : "Decline"}
        </Button>
      </div>
    </article>
  );
}
