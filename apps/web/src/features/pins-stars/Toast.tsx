import { dismiss, runUndo, useToast } from "./toast.ts";

/** ToastHost draws the toast, if there is one. It is a polite live region, so a screen reader says it too; an error is an alert, said at once. */
export function ToastHost() {
  const text = useToast((s) => s.text);
  const undo = useToast((s) => s.undo);
  const label = useToast((s) => s.label);
  // Only a showing error is an alert: an empty toast never adds a second role=alert next to the page's own.
  const alert = useToast((s) => s.alert) && !!text;
  return (
    <div className="toastbox" role={alert ? "alert" : "status"} aria-live={alert ? "assertive" : "polite"}>
      {text ? (
        <div className="toast">
          <span className="toasttext">{text}</span>
          {undo ? (
            <button type="button" className="toastact" onClick={runUndo}>
              {label}
            </button>
          ) : null}
          <button type="button" className="toastx" aria-label="Dismiss" onClick={dismiss}>
            <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
              <path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
          </button>
        </div>
      ) : null}
    </div>
  );
}
