import type { Machine } from "@convoz/api-client";
import { Sheet } from "@convoz/ui/Sheet";
import { useEffect, useState, type ReactNode } from "react";
import { ApiError, call, client, stepUp } from "../../shared/api.ts";
import { data } from "../../shared/data.ts";
import { StepUpSheet } from "../../shared/sheets.tsx";
import { admits } from "./allow.ts";

type Open = (make: (close: () => void) => ReactNode) => void;

interface Props {
  close: () => void;
  open: Open;
  /** The agent exists: the list reads the crew again. */
  onDone: () => void;
}

/**
 * AddAgentSheet makes an agent behind a passkey check. The agent has no key: a machine that allows its handle speaks for it, so
 * the next sheet says how that comes about (the one-line prompt, or "Allow on machine…" and `convoz login`).
 */
export default function AddAgentSheet({ close, open, onDone }: Props) {
  return (
    <StepUpSheet
      title="Add agent"
      intro="An agent has a handle that is never used again and a name you can read."
      confirm="Add agent"
      action="identity.create"
      close={close}
      fields={[
        { key: "handle", label: "Handle", hint: "Lowercase letters, digits and dashes.", attrs: { autoFocus: true } },
        { key: "display_name", label: "Display name" },
      ]}
      perform={async (stepId, v) => {
        const handle = (v.handle ?? "").trim().toLowerCase();
        try {
          await call(client.POST("/api/crew/agents", { params: { header: stepUp(stepId) }, body: { handle, display_name: (v.display_name ?? "").trim() || handle } }));
        } catch (err) {
          if (err instanceof ApiError && err.code === "handle_taken") {
            const mine = data.store.getState().identities?.find((p) => p.handle === handle);
            throw new ApiError(
              mine && !mine.disabled ? `The handle "${handle}" is taken.` : `The handle "${handle}" was used before and cannot be used again.`,
              err.status,
              err.code,
            );
          }
          throw err;
        }
        onDone();
        open((closeNext) => <HowItConnects handle={handle} open={open} close={closeNext} />);
      }}
    />
  );
}

/** admitted: some machine already lets this handle in. */
function HowItConnects({ handle, open, close }: { handle: string; open: Open; close: () => void }) {
  const [machines, setMachines] = useState<Machine[] | null>(null);
  const [done, setDone] = useState(false);
  useEffect(() => {
    call(client.GET("/api/machines")).then((r) => setMachines(r.machines), () => setMachines([]));
  }, []);
  const ready = done || (machines?.some((m) => admits(m.allow, handle)) ?? false);
  return (
    <Sheet
      title={`@${handle} added`}
      onClose={close}
      actions={
        <button className="btn primary" type="button" onClick={close}>
          Done
        </button>
      }
    >
      {machines === null ? null : ready ? (
        <p>{`You're @${handle} on Convoz. Run convoz brief first.`}</p>
      ) : (
        <>
          <p className="lead">Allow on machine…</p>
          <ul className="group" aria-label="Machines">
            {machines.map((m) => (
              <li key={m.id}>
                <button className="btn small" type="button" onClick={() => open((c) => <AllowSheet m={m} handle={handle} close={c} done={() => setDone(true)} />)}>
                  {m.name}
                </button>
              </li>
            ))}
          </ul>
          <p className="muted">
            On a new machine run <code>convoz login</code>.
          </p>
        </>
      )}
    </Sheet>
  );
}

function AllowSheet({ m, handle, close, done }: { m: Machine; handle: string; close: () => void; done: () => void }) {
  return (
    <StepUpSheet
      title={`Allow @${handle} on ${m.name}`}
      confirm="Allow"
      action="machine.allow"
      target={m.id}
      close={close}
      perform={async (stepId) => {
        const allow = { mode: "list" as const, identities: [...m.allow.identities, handle], globs: m.allow.globs };
        await call(client.PATCH("/api/machines/{id}", { params: { path: { id: m.id }, header: stepUp(stepId) }, body: { allow } }));
        done();
      }}
    />
  );
}
