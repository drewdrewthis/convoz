import { useEffect, useState, type FormEvent } from "react";
import { call, client, humanError, page } from "../../shared/api.ts";
import { useCeremony } from "../../shared/ceremony.ts";
import { useNotice } from "../../shared/notice.tsx";
import { registerTicket } from "../../shared/tickets.ts";
import { Button } from "@convoz/ui/Button";
import { Field } from "@convoz/ui/Field";
import { withBase } from "../../shared/base.ts";

/** Recover is /recover: a recovery code gives a limited session, which may only add a passkey on this device. */
export function Recover() {
  const { fail } = useNotice();
  const [code, setCode] = useState("");
  const [accepted, setAccepted] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    fail("");
    try {
      await call(client.POST("/api/auth/recovery", { body: { code: code.replace(/\s+/g, "") } }));
    } catch (err) {
      fail(humanError(err));
      return;
    }
    setAccepted(true);
  };

  if (accepted) return <AddThisDevice />;
  return (
    <>
      <p className="text-15 text-muted">Type one of the recovery codes you saved. It works once.</p>
      <form id="recover-form" className="stack" noValidate onSubmit={submit}>
        <Field id="code" name="code" label="Recovery code" mono required value={code} onChange={(e) => setCode(e.target.value)} />
        <div className="actions">
          <Button variant="primary" type="submit">
            Use code
          </Button>
        </div>
      </form>
    </>
  );
}

function AddThisDevice() {
  const { fail } = useNotice();
  const [t] = useState(() => registerTicket((err) => fail(humanError(err))));
  useEffect(() => {
    t.refresh();
    return () => t.drop();
  }, [t]);
  const ceremony = useCeremony(
    t,
    async () => {
      const started = await t.use(); // one create prompt, at once
      await call(client.POST("/api/auth/passkey/register/verify", { body: started }));
      page.leaving = true;
      location.assign(withBase("/"));
    },
    { fail },
  );
  return (
    <>
      <p className="text-15 text-muted">Code accepted. Add a passkey on this device to finish.</p>
      <div className="actions">
        <Button variant="primary" {...ceremony}>
          Add a passkey
        </Button>
      </div>
    </>
  );
}
