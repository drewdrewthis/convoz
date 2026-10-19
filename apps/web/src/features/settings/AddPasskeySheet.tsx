import { Sheet } from "@convoz/ui/Sheet";
import { useEffect, useRef, useState } from "react";
import { ApiError, call, client, humanError } from "../../shared/api.ts";
import { useCeremony } from "../../shared/ceremony.ts";
import { CancelButton } from "../../shared/sheets.tsx";
import { finishStepUp, registerTicket, stepUpTicket, type TicketLike } from "../../shared/tickets.ts";
import { Button } from "@convoz/ui/Button";

/**
 * AddPasskeySheet adds a passkey in two taps, one ceremony each (iOS allows one per tap): tap 1 "Confirm it's you" (a get),
 * tap 2 "Create the new passkey" (a create). Both options are fetched when the sheet opens.
 */
export function AddPasskeySheet({ close, onAdded }: { close: () => void; onAdded: () => void }) {
  const [alert, setAlert] = useState("");
  const [phase, setPhase] = useState<"check" | "create">("check");
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  const stepId = useRef("");
  const open = useRef(true);
  const [{ check, create, current }] = useState(() => {
    const showError = (err: unknown) => setAlert(humanError(err));
    const check = stepUpTicket("passkey.add", null, showError);
    const create = registerTicket(showError);
    const now = () => (phaseRef.current === "check" ? check : create);
    // The one ticket the button sees is whichever of the two the next tap needs.
    const current: TicketLike = {
      get ready() {
        return now().ready;
      },
      stale: () => now().stale(),
      refresh: () => void now().refresh(),
      subscribe: (fn) => {
        const a = check.subscribe(fn);
        const b = create.subscribe(fn);
        return () => {
          a();
          b();
        };
      },
    };
    return { check, create, current };
  });

  useEffect(() => {
    check.refresh();
    create.refresh();
    return () => {
      open.current = false;
      check.drop();
      create.drop();
    };
  }, [check, create]);

  const ceremony = useCeremony(
    current,
    async () => {
      if (phaseRef.current === "check") {
        stepId.current = await finishStepUp(check.use()); // tap 1: the browser prompt opens at once
        phaseRef.current = "create";
        setPhase("create");
        check.refresh(); // the next tap that needs a check starts from fresh options
        return;
      }
      const started = await create.use(); // tap 2
      await call(client.POST("/api/auth/passkey/register/verify", { body: started, params: { header: { "X-Convoz-Step-Up": stepId.current } } }));
      close();
      onAdded();
    },
    {
      fail: setAlert,
      alive: () => open.current,
      onError: (err) => {
        if (err instanceof ApiError && err.code === "step_up_invalid") {
          phaseRef.current = "check";
          setPhase("check");
          create.refresh();
        }
      },
    },
  );

  return (
    <Sheet
      title="Add a passkey"
      alert={alert}
      onClose={close}
      actions={
        <>
          <Button variant="primary" {...ceremony}>
            {phase === "check" ? "Confirm it's you" : "Create the new passkey"}
          </Button>
          <CancelButton onClick={close} />
        </>
      }
    >
      <p className="text-muted">First confirm it is you with a passkey you already have. Then create the new one on the device or security key you want to add.</p>
    </Sheet>
  );
}
