import type { Passkey } from "@convoz/api-client";
import { useCallback, useEffect, useRef, useState } from "react";
import { call, client, fmtDate, humanError, stepUp } from "../../shared/api.ts";
import { useNotice } from "../../shared/notice.tsx";
import { StepUpSheet, useSheets } from "../../shared/sheets.tsx";
import { AddPasskeySheet } from "./AddPasskeySheet.tsx";
import { Button } from "@convoz/ui/Button";

const VIA: Record<string, string> = { bootstrap: "Added with the setup link", session: "Added in settings", recovery: "Added with a recovery code" };

/** Passkeys is /settings/passkeys: the owner's passkeys, add one (two taps), remove one (a passkey check; never the last). */
export function Passkeys() {
  const { fail } = useNotice();
  const { sheet, open } = useSheets();
  const [rows, setRows] = useState<Passkey[]>([]);
  const [fresh, setFresh] = useState<Set<number>>(new Set());
  const known = useRef<Set<number> | null>(null);

  // Passkeys are never cached (design §9: auth data is network-only), so this page asks the server each time.
  const load = useCallback(async () => {
    const { passkeys } = await call(client.GET("/api/me/passkeys"));
    setFresh(new Set(known.current ? passkeys.filter((p) => !known.current!.has(p.id)).map((p) => p.id) : []));
    known.current = new Set(passkeys.map((p) => p.id));
    setRows(passkeys);
  }, []);

  useEffect(() => {
    load().catch((err) => fail(humanError(err)));
  }, [load, fail]);

  const remove = (p: Passkey) => {
    if (rows.length <= 1) {
      fail("Another passkey must be added first.");
      return;
    }
    open((close) => (
      <StepUpSheet
        title="Remove passkey"
        intro={`Remove "${p.label}"${p.this_device ? ", the one this device uses" : ""}? It can no longer sign in to Convoz.`}
        confirm="Remove"
        tone="danger"
        action="passkey.remove"
        target={p.id}
        close={close}
        perform={async (stepId) => {
          await call(client.DELETE("/api/me/passkeys/{id}", { params: { path: { id: p.id }, header: stepUp(stepId) } }));
          await load();
        }}
      />
    ));
  };

  return (
    <>
      <ul id="passkeys" className="group" aria-label="Passkeys">
        {rows.map((p) => (
          <li key={p.id} className="row">
            <div className="grow">
              <strong>{p.label}</strong>
              {p.this_device ? <span className="badge">This device</span> : null}
              <div className="sub">{`${VIA[p.registered_via] || "Added"}${fresh.has(p.id) ? " · Added just now" : ""}`}</div>
              <div className="sub">{p.last_used_at ? `Last used ${fmtDate(p.last_used_at)}` : "Never used"}</div>
            </div>
            <Button className="flex-none" size="small" onClick={() => remove(p)}>
              Remove passkey
            </Button>
          </li>
        ))}
      </ul>
      <div className="actions">
        <Button id="add" variant="primary" onClick={() => open((close) => <AddPasskeySheet close={close} onAdded={() => void load()} />)}>
          Add a passkey
        </Button>
      </div>
      {sheet}
    </>
  );
}
