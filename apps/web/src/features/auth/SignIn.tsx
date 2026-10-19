import { useEffect, useState } from "react";
import { call, client, humanError, page, safeNext } from "../../shared/api.ts";
import { useCeremony } from "../../shared/ceremony.ts";
import { useNotice } from "../../shared/notice.tsx";
import { data } from "../../shared/data.ts";
import { loginTicket, supported } from "../../shared/tickets.ts";
import { Button } from "@convoz/ui/Button";

/** SignIn is /signin: one passkey prompt, then back to ?next= (Now by default). A browser already signed in goes on at once. */
export function SignIn() {
  const { say, fail } = useNotice();
  const [params] = useState(() => new URLSearchParams(location.search));
  const next = params.has("next") ? safeNext(params.get("next")) : "/";
  const [canUse] = useState(supported);
  const [t] = useState(() => loginTicket((err) => fail(humanError(err))));

  useEffect(() => {
    if (params.has("signed_out")) say("Signed out");
    data
      .loadMe()
      .then((me) => {
        if (!me.device?.limited) location.replace(next);
      })
      .catch(() => {});
    if (!canUse) {
      fail("This browser cannot use passkeys. Try Safari, Chrome or Edge.");
      return;
    }
    t.refresh();
    return () => t.drop();
  }, [t, canUse, params, next, say, fail]);

  const ceremony = useCeremony(
    t,
    async () => {
      const started = await t.use(); // the prompt opens at once
      await call(client.POST("/api/auth/passkey/login/verify", { body: started }));
      page.leaving = true;
      location.assign(next);
    },
    { fail },
  );

  return (
    <>
      <p className="text-15 text-muted">Use the passkey on this device.</p>
      <div className="actions">
        <Button id="signin" variant="primary" {...ceremony} disabled={!canUse || ceremony.disabled}>
          Sign in with a passkey
        </Button>
        <Button variant="quiet" href="/recover">
          Lost your passkey? Use a recovery code
        </Button>
      </div>
    </>
  );
}
