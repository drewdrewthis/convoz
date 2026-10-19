import { useEffect, useState } from "react";
import { call, client, humanError, stepUp } from "../../shared/api.ts";
import { useCeremony } from "../../shared/ceremony.ts";
import { CodesBlock } from "../../shared/codes.tsx";
import { useNotice } from "../../shared/notice.tsx";
import { finishStepUp, stepUpTicket } from "../../shared/tickets.ts";
import { Button } from "@convoz/ui/Button";

/** RecoveryCodes is /settings/recovery: how many codes are left, and new codes after one passkey check (shown once). */
export function RecoveryCodes() {
  const { fail } = useNotice();
  const [left, setLeft] = useState("Checking your codes.");
  const [codes, setCodes] = useState<string[] | null>(null);
  const [t] = useState(() => stepUpTicket("recovery.regenerate", null, (err) => fail(humanError(err))));

  const count = async () => {
    const { remaining } = await call(client.GET("/api/me/recovery-codes"));
    setLeft(`${remaining} of 10 codes left`);
  };

  useEffect(() => {
    t.refresh();
    count().catch((err) => fail(humanError(err)));
    return () => t.drop();
  }, [t, fail]);

  const ceremony = useCeremony(
    t,
    async () => {
      const stepId = await finishStepUp(t.use()); // one get prompt, at once
      const done = await call(client.POST("/api/me/recovery-codes", { body: {}, params: { header: stepUp(stepId) } }));
      setCodes(done.recovery_codes);
      await count();
    },
    { fail },
  );

  return (
    <>
      <p id="left" className="text-15 text-muted">
        {left}
      </p>
      <p className="text-muted">Making new codes stops the old ones from working.</p>
      <div id="fresh">
        {codes ? (
          <>
            <p className="banner">Your new codes. Save them now: they are shown only once. The old codes no longer work.</p>
            <CodesBlock codes={codes} />
          </>
        ) : null}
      </div>
      <div className="actions">
        <Button id="make" variant="primary" {...ceremony}>
          Make new codes
        </Button>
      </div>
    </>
  );
}
