import { useEffect, useState } from "react";
import { usePageHead } from "../../shared/page-head.tsx";
import { isPhone } from "../../shared/api.ts";
import { useNotice } from "../../shared/notice.tsx";
import { useSheets } from "../../shared/sheets.tsx";
import { AddPasskeySheet } from "../settings/index.ts";
import { Button } from "@convoz/ui/Button";

/** Onboarding is /onboarding, step 3 of 3: a second passkey on another device or a hardware key, or skip it for now. */
export function Onboarding() {
  const head = usePageHead();
  const { say } = useNotice();
  const { sheet, open } = useSheets();
  const [added, setAdded] = useState(false);
  const [phone] = useState(isPhone);
  useEffect(() => head.setStep("Step 3 of 3"), [head]);
  const add = () =>
    open((close) => (
      <AddPasskeySheet
        close={close}
        onAdded={() => {
          say("Passkey added. You now have a second way in.");
          setAdded(true);
        }}
      />
    ));
  return (
    <>
      <p className="lead">Add a passkey on another device or a hardware key</p>
      {phone ? <p className="muted">On a phone, use your laptop or a security key for the second passkey.</p> : null}
      <p className="muted">A second passkey keeps you from being locked out if you lose this one.</p>
      <div className="actions">
        {added ? null : (
          <Button variant="primary" onClick={add}>
            Add a passkey
          </Button>
        )}
        <Button variant="quiet" onClick={() => location.assign("/")}>
          {added ? "Continue to Now" : "Skip for now"}
        </Button>
      </div>
      {sheet}
    </>
  );
}
