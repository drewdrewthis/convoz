import { Field } from "@convoz/ui/Field";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { usePageHead } from "../../shared/page-head.tsx";
import { call, client, humanError, page } from "../../shared/api.ts";
import { useCeremony } from "../../shared/ceremony.ts";
import { CodesBlock } from "../../shared/codes.tsx";
import { useNotice } from "../../shared/notice.tsx";
import { data } from "../../shared/data.ts";
import { bootstrapTicket, supported } from "../../shared/tickets.ts";
import { Button } from "@convoz/ui/Button";

/**
 * Bootstrap is /bootstrap#cvz_b_…: step 1 of 3 registers the first passkey from a setup link, step 2 shows the recovery codes
 * once (in memory only). A different link in the same tab (only the #fragment changes, so the page is not reloaded) starts over.
 */
export function Bootstrap() {
  const [gen, setGen] = useState(0);
  const head = usePageHead();
  const { say, fail } = useNotice();
  useEffect(() => {
    const restart = () => {
      head.setStep("");
      head.setHeading("");
      fail("");
      say("");
      setGen((g) => g + 1);
    };
    addEventListener("hashchange", restart);
    return () => removeEventListener("hashchange", restart);
  }, [head, say, fail]);
  return <SetupLink key={gen} />;
}

const HEADINGS: Record<string, string> = { used: "This link was already used", expired: "This link expired" };

function SetupLink() {
  const head = usePageHead();
  const { fail } = useNotice();
  const [view, setView] = useState<ReactNode>(<p className="muted">Checking your setup link.</p>);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [token] = useState(() => location.hash.slice(1));

  useEffect(() => {
    let live = true;
    const dead = async (title: string) => {
      head.setHeading(title);
      let signedIn = false;
      try {
        signedIn = !(await data.loadMe()).device?.limited;
      } catch {
        /* no session */
      }
      if (!live) return;
      setView(
        <>
          <p className="lead">Setup links work once and only for ten minutes.</p>
          {signedIn ? (
            <div className="actions">
              <Button variant="primary" href="/">
                Go to Convoz
              </Button>
            </div>
          ) : (
            <div>
              <p>To get a new link, run this on the server:</p>
              <p>
                <code>convoz admin bootstrap-link</code>
              </p>
            </div>
          )}
        </>,
      );
    };
    (async () => {
      if (!token) return dead("This link is not valid");
      let state: string;
      try {
        state = (await call(client.POST("/api/auth/bootstrap/check", { body: { token } }))).state;
      } catch (err) {
        fail(humanError(err));
        return;
      }
      if (!live) return;
      if (state !== "ok") return dead(HEADINGS[state] || "This link is not valid");
      if (!supported()) {
        head.setHeading("Passkeys are not available");
        setView(<p>This browser cannot make passkeys. Open the link in Safari, Chrome or Edge.</p>);
        return;
      }
      head.setStep("Step 1 of 3");
      head.setHeading("Welcome to Convoz");
      setView(<FirstPasskey token={token} onCodes={setCodes} />);
    })();
    return () => {
      live = false;
    };
  }, [token, head, fail]);

  return codes ? <SaveCodes codes={codes} /> : <>{view}</>;
}

const validHandle = (h: string) => /^[a-z][a-z0-9-]{1,39}$/.test(h);

function FirstPasskey({ token, onCodes }: { token: string; onCodes: (codes: string[]) => void }) {
  const { fail } = useNotice();
  const [handle, setHandle] = useState("");
  const [display, setDisplay] = useState("");
  const fields = useRef({ handle, display });
  fields.current = { handle, display };
  // One ticket for the whole form: it reads the fields when it fetches, and a change of either field voids it.
  const [t] = useState(() =>
    bootstrapTicket(
      () => call(client.POST("/api/auth/bootstrap/options", { body: { token, handle: fields.current.handle, display_name: fields.current.display.trim() } })),
      (err) => fail(humanError(err)),
    ),
  );
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(
    () => () => {
      clearTimeout(timer.current);
      t.drop();
    },
    [t],
  );
  const valid = validHandle(handle) && display.trim().length > 0;

  const edited = (next: { handle: string; display: string }) => {
    fields.current = next;
    clearTimeout(timer.current);
    t.drop();
    fail("");
    if (validHandle(next.handle) && next.display.trim().length > 0) timer.current = setTimeout(t.refresh, 350); // wait for a pause in typing, then fetch
  };

  const ceremony = useCeremony(
    t,
    async () => {
      const started = await t.use(); // the passkey prompt opens at once: the options were fetched before the tap
      const done = await call(client.POST("/api/auth/bootstrap/verify", { body: started }));
      page.leaving = true; // the link is spent: no more options to fetch
      if (done.recovery_codes) onCodes(done.recovery_codes);
      else location.assign("/");
    },
    { fail, also: valid },
  );

  return (
    <form className="stack" noValidate onSubmit={(event) => event.preventDefault()}>
      <p className="lead">Convoz is your private workspace for people and agents. Create the first passkey to own it.</p>
      <Field
        label="Handle"
        hint="Lowercase letters, numbers and dashes. It starts with a letter and never changes."
        autoComplete="username"
        maxLength={40}
        required
        value={handle}
        onChange={(e) => {
          setHandle(e.target.value);
          edited({ handle: e.target.value, display });
        }}
      />
      <Field
        label="Display name"
        autoComplete="name"
        autoCapitalize="words"
        maxLength={80}
        required
        value={display}
        onChange={(e) => {
          setDisplay(e.target.value);
          edited({ handle, display: e.target.value });
        }}
      />
      <div className="actions">
        <Button variant="primary" type="submit" {...ceremony}>
          Register passkey
        </Button>
      </div>
    </form>
  );
}

/** Step 2 of 3: the codes live in memory only; nothing is stored for a later visit. */
function SaveCodes({ codes }: { codes: string[] }) {
  const head = usePageHead();
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    head.setStep("Step 2 of 3");
    head.setHeading("Save your recovery codes");
    window.scrollTo(0, 0);
  }, [head]);
  return (
    <>
      <p className="lead">Each code works once. Use one if you ever lose your passkey. Convoz shows them only now.</p>
      <CodesBlock codes={codes} />
      <div className="actions">
        <label className="check">
          <input type="checkbox" id="saved" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
          <span>I saved them</span>
        </label>
        <Button variant="primary" disabled={!saved} onClick={() => location.assign("/onboarding")}>
          Continue
        </Button>
      </div>
    </>
  );
}
