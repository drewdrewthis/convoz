import { CloseIcon } from "@convoz/ui/icons";
import { useEffect, useState } from "react";
import { humanError } from "../../shared/api.ts";
import { currentSubscription, pushSupported, PushStepError, turnOn } from "./push.ts";

const DISMISSED = "convoz.push-banner-dismissed";

function dismissedHere(): boolean {
  try {
    return localStorage.getItem(DISMISSED) === "1";
  } catch {
    return false; // no storage: the banner shows each time, which is the safe side
  }
}

function rememberDismissed(): void {
  try {
    localStorage.setItem(DISMISSED, "1");
  } catch {
    /* private mode: it comes back on the next open */
  }
}

/**
 * PushBanner asks once, at the top of the main app, to turn notifications on. Only a device that can do push, has not decided
 * (permission "default"), has no subscription and was not dismissed sees it. The tap runs the same turnOn as Settings, so the
 * permission prompt stays the first await inside the tap (iOS needs the gesture).
 */
export function PushBanner() {
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    if (!pushSupported() || Notification.permission !== "default" || dismissedHere()) return;
    let live = true;
    void currentSubscription().then((sub) => live && setShow(!sub), () => undefined);
    return () => void (live = false);
  }, []);

  if (!show) return null;

  const tap = async () => {
    setBusy(true);
    setError("");
    try {
      await turnOn(setStep);
      setShow(false);
    } catch (err) {
      setError(err instanceof PushStepError ? err.message : humanError(err));
      // Settings explains a block; the banner has nothing more to offer.
      if (Notification.permission === "denied") setShow(false);
    } finally {
      setStep("");
      setBusy(false);
    }
  };

  return (
    <section className="pushbanner" aria-label="Notifications">
      <div className="pushbanner-row">
        <span className="grow">{step || "Turn on notifications"}</span>
        <button className="btn small" type="button" disabled={busy} onClick={() => void tap()}>
          Turn on
        </button>
        <button
          className="iconbtn"
          type="button"
          aria-label="Dismiss"
          disabled={busy}
          onClick={() => {
            rememberDismissed();
            setShow(false);
          }}
        >
          <CloseIcon />
        </button>
      </div>
      {error ? <p role="alert">{error}</p> : null}
    </section>
  );
}
