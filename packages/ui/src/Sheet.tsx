import { useEffect, useLayoutEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";

export interface SheetProps {
  /** The sheet's heading and accessible name. */
  title: string;
  /** An error shown above the actions (role=alert); empty for none. */
  alert?: string;
  /** The buttons pinned at the bottom. */
  actions: ReactNode;
  /** Runs however the sheet closes (Escape, the browser, or the parent unmounting it after its own close). */
  onClose: () => void;
  children?: ReactNode;
}

/**
 * Sheet is a modal sheet (a native <dialog>, opened with showModal). The parent closes it by unmounting it; Escape closes it
 * through onClose. Its form never submits: the buttons run their own handlers.
 */
export function Sheet({ title, alert, actions, onClose, children }: SheetProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const alertRef = useRef<HTMLParagraphElement>(null);
  const closed = useRef(onClose);
  closed.current = onClose;

  useLayoutEffect(() => {
    const d = dialog.current!;
    const onCloseEvent = () => closed.current();
    d.addEventListener("close", onCloseEvent);
    d.showModal();
    return () => {
      d.removeEventListener("close", onCloseEvent);
      if (d.open) d.close();
    };
  }, []);

  useEffect(() => {
    alertRef.current?.scrollIntoView({ block: "nearest" });
  }, [alert]);

  return createPortal(
    <dialog ref={dialog} aria-label={title}>
      <form noValidate onSubmit={(event) => event.preventDefault()}>
        <h2>{title}</h2>
        {children}
        {alert ? (
          <p ref={alertRef} role="alert">
            {alert}
          </p>
        ) : null}
        <div className="sheet-actions">{actions}</div>
      </form>
    </dialog>,
    document.body,
  );
}
