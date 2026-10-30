import { runUndo, useToast } from "./toast.ts";

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
          <span>{text}</span>
          {undo ? (
            <button type="button" className="toastact" onClick={runUndo}>
              {label}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
