import { useToast } from "./toast.ts";

/** ToastHost draws the toast, if there is one. It is a polite live region, so a screen reader says it too. */
export function ToastHost() {
  const text = useToast((s) => s.text);
  return (
    <div className="toastbox" role="status" aria-live="polite">
      {text ? <div className="toast">{text}</div> : null}
    </div>
  );
}
