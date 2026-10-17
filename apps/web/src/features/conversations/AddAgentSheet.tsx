import type { Identity } from "@convoz/api-client";
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
  onAdd(identityId: number, history: "since_now" | "full"): Promise<void>;
}

/** AddAgentSheet is the dialog "Add agent": pick an agent that is not here, say what history it sees, add. */
export function AddAgentSheet({ id, done, onAdd }: AddAgentProps) {
  const people = useData((s) => s.identities);
  const row = useData((s) => s.rows[id]);
  const [picked, setPicked] = useState<Identity | null>(null);
  const [history, setHistory] = useState<"since_now" | "full">("since_now");
  const [alert, setAlert] = useState("");
  useEffect(() => {
    data.loadIdentities().catch(() => {});
  }, []);
  const here = new Set((row?.participants ?? []).map((p) => p.handle));
  const choices = (people ?? []).filter((p) => p.kind === "agent" && !p.disabled && !here.has(p.handle));

  const add = () =>
    picked &&
    onAdd(picked.id, history).then(done, (err) => setAlert(humanError(err)));

  return (
    <Sheet
      title="Add agent"
      alert={alert}
      onClose={done}
      actions={
        <>
          <button type="button" className="btn primary" disabled={!picked} onClick={() => void add()}>
            {picked ? `Add @${picked.handle}` : "Add"}
          </button>
          <CancelButton onClick={done} />
        </>
      }
    >
      {picked ? (
        <fieldset className="historyset">
          <legend>What can @{picked.handle} see?</legend>
          <label className="check">
            <input type="radio" name="history" value="since_now" checked={history === "since_now"} onChange={() => setHistory("since_now")} />
            Since now
          </label>
          <label className="check">
            <input type="radio" name="history" value="full" checked={history === "full"} onChange={() => setHistory("full")} />
            Full history
          </label>
          <button type="button" className="btn small quiet" onClick={() => setPicked(null)}>
            Pick another agent
          </button>
        </fieldset>
      ) : (
        <>
          <ul className="agents" role="list" aria-label="Agents to add">
            {choices.map((p) => (
              <li key={p.id}>
                <button type="button" className="agentbtn" onClick={() => setPicked(p)}>
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
        </>
      )}
    </Sheet>
  );
}
