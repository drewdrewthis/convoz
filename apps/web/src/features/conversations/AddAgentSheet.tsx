import { Sheet } from "@convoz/ui/Sheet";
import { useEffect, useState } from "react";
import { humanError } from "../../shared/api.ts";
import { initials, paletteOf } from "../../shared/chat.ts";
import { data, useData } from "../../shared/data.ts";
import { CancelButton } from "../../shared/sheets.tsx";

export interface AddAgentProps {
  /** The conversation; the sheet reads its row from the cache, so it follows the agents that come and go meanwhile. */
  id: number;
  done(): void;
  /** Brings the agent in; it joins at once and sees the whole history (prototype v41: no history question). */
  onAdd(identityId: number, handle: string): Promise<void>;
  /** "Invite a new agent": closes this dialog and opens the invite prompt for the conversation. */
  onInvite(): void;
}

/** AddAgentSheet is the dialog "Add agent" of + Add: tap an agent that is not here and it joins at once. */
export function AddAgentSheet({ id, done, onAdd, onInvite }: AddAgentProps) {
  const people = useData((s) => s.identities);
  const row = useData((s) => s.rows[id]);
  const [alert, setAlert] = useState("");
  useEffect(() => {
    data.loadIdentities().catch(() => {});
  }, []);
  const here = new Set((row?.participants ?? []).map((p) => p.handle));
  const choices = (people ?? []).filter((p) => p.kind === "agent" && !p.disabled && !here.has(p.handle));

  return (
    <Sheet title="Add agent" alert={alert} onClose={done} actions={<CancelButton onClick={done} />}>
      <ul className="agents" role="list" aria-label="Agents to add">
        {choices.map((p) => (
          <li key={p.id}>
            <button type="button" className="agentbtn" onClick={() => void onAdd(p.id, p.handle).then(done, (err) => setAlert(humanError(err)))}>
              <span className={`ava p${paletteOf(p.handle)}`} aria-hidden="true" data-l={initials(p.handle)} />
              <span className="who">
                <span className="handle">@{p.handle}</span>
                <span className="name">{p.display_name}</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
      {people && choices.length === 0 ? <p className="muted">No other agent to add.</p> : null}
      <button type="button" className="btn small quiet" onClick={() => { done(); onInvite(); }}>
        Invite a new agent…
      </button>
    </Sheet>
  );
}
