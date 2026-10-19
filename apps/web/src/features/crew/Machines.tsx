import type { Machine } from "@convoz/api-client";
import { Sheet } from "@convoz/ui/Sheet";
import { useCallback, useEffect, useState } from "react";
import { call, client, humanError, stepUp } from "../../shared/api.ts";
import { useNotice } from "../../shared/notice.tsx";
import { StepUpSheet, useSheets } from "../../shared/sheets.tsx";
import { allowText, parseAllow } from "./allow.ts";
import { ago } from "./status.ts";
import { Button } from "@convoz/ui/Button";
import { EmptyState } from "@convoz/ui/EmptyState";
import { List, ListRow } from "@convoz/ui/ListRow";

type Open = ReturnType<typeof useSheets>["open"];

/** Machines is /crew/machines: each machine with its allow-list, and the key actions behind a passkey check. Never cached (design §9). */
export function Machines() {
  const { fail } = useNotice();
  const { sheet, open } = useSheets();
  const [machines, setMachines] = useState<Machine[] | null>(null);
  const reload = useCallback(async () => {
    setMachines((await call(client.GET("/api/machines"))).machines);
  }, []);
  useEffect(() => {
    reload().catch((err) => fail(humanError(err)));
  }, [reload, fail]);
  return (
    <>
      <div id="machines" aria-label="Machines">
        {machines === null ? null : machines.length ? (
          <List>
            {machines.map((m) => (
              <MachineItem key={m.id} m={m} reload={reload} open={open} />
            ))}
          </List>
        ) : (
          <EmptyState>No machines yet. Run convoz login on one.</EmptyState>
        )}
      </div>
      {sheet}
    </>
  );
}

type KeyPath = "reveal" | "regenerate" | "revoke";

function MachineItem({ m, reload, open }: { m: Machine; reload: () => Promise<void>; open: Open }) {
  const act = (label: string, action: "machine.reveal" | "machine.regenerate" | "machine.revoke", path: KeyPath, intro: string, tone?: "danger") => (
    <Button
      className="flex-none"
      size="small"
      onClick={() =>
        open((close) => (
          <StepUpSheet
            title={`${label} ${m.name}`}
            intro={intro}
            confirm={label}
            tone={tone}
            action={action}
            target={m.id}
            close={close}
            perform={async (stepId) => {
              const done = await call(client.POST(`/api/machines/{id}/${path}`, { params: { path: { id: m.id }, header: stepUp(stepId) }, body: {} }));
              if (done.machine_key) {
                const key = done.machine_key;
                open((closeKey) => <KeySheet title={`Key of ${m.name}`} machineKey={key} close={closeKey} />);
              }
              await reload();
            }}
          />
        ))
      }
    >
      {label}
    </Button>
  );
  const edit = () =>
    open((close) => (
      <StepUpSheet
        title={`Allow-list of ${m.name}`}
        confirm="Save"
        action="machine.allow"
        target={m.id}
        close={close}
        fields={[
          {
            key: "allowed",
            label: "Allowed identities",
            hint: "Handles and patterns such as dev-*, separated by commas. Use * for every agent.",
            initial: m.allow.mode === "any" ? "*" : [...m.allow.identities, ...m.allow.globs].join(", "),
          },
        ]}
        perform={async (stepId, values) => {
          const text = values.allowed ?? "";
          const allow = text.trim() === "*" ? { mode: "any" as const, identities: [], globs: [] } : parseAllow(text);
          await call(client.PATCH("/api/machines/{id}", { params: { path: { id: m.id }, header: stepUp(stepId) }, body: { allow } }));
          await reload();
        }}
      />
    ));
  return (
    <ListRow stacked>
      <div>
        <strong>{m.name}</strong> <code>{m.key_hint}</code>
      </div>
      <div className="text-13 text-muted">{`Allowed: ${allowText(m.allow)}. Scopes: ${m.scopes.join(", ")}.`}</div>
      <div className="text-13 text-muted">{`${m.live_sessions} live ${m.live_sessions === 1 ? "session" : "sessions"} · ${m.last_used_at ? `last used ${ago(m.last_used_at)}` : "never used"}`}</div>
      <div className="btns wrap">
        {act("Reveal", "machine.reveal", "reveal", "Show this machine's key once. This needs a passkey check.")}
        {act("Regenerate", "machine.regenerate", "regenerate", "Make a new key. The old key and its sessions stop working at once.", "danger")}
        {act("Revoke", "machine.revoke", "revoke", "Its key and sessions stop working at once.", "danger")}
        <Button className="flex-none" size="small" onClick={edit}>
          Edit allow-list
        </Button>
      </div>
    </ListRow>
  );
}

/** KeySheet shows a machine key once, to copy. */
function KeySheet({ title, machineKey, close }: { title: string; machineKey: string; close: () => void }) {
  const { say } = useNotice();
  const [alert, setAlert] = useState("");
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(machineKey);
      say("Copied.");
    } catch {
      setAlert("Copying did not work. Select the key and copy it by hand.");
    }
  };
  return (
    <Sheet
      title={title}
      alert={alert}
      onClose={close}
      actions={
        <>
          <Button onClick={copy}>
            Copy key
          </Button>
          <Button variant="primary" onClick={close}>
            Done
          </Button>
        </>
      }
    >
      <p className="text-muted">Copy the key now. It is not shown again unless you reveal it with a passkey.</p>
      <p className="text-muted">Paste into convoz login --stdin on the machine, never into an agent prompt.</p>
      <p>
        <output className="mono" aria-label="Machine key">
          {machineKey}
        </output>
      </p>
    </Sheet>
  );
}
