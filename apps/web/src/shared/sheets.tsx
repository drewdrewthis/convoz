// Sheets that need a passkey check. A sheet is rendered by the page that opens it (useSheets) and closed by unmounting it.
import { Field } from "@convoz/ui/Field";
import { Sheet } from "@convoz/ui/Sheet";
import type { StepUpAction } from "@convoz/api-client";
import { Fragment, useCallback, useEffect, useRef, useState, type InputHTMLAttributes, type ReactNode } from "react";
import { humanError } from "./api.ts";
import { useCeremony } from "./ceremony.ts";
import { useNotice } from "./notice.tsx";
import { finishStepUp, stepUpTicket } from "./tickets.ts";
import { Button } from "@convoz/ui/Button";

/**
 * useSheets holds the sheets a page shows (one, or a second over it: a machine key over the check that revealed it). Each
 * sheet gets its own `close`. `open` clears the page's error first, as every sheet does. Render `sheets` in the page.
 */
export function useSheets() {
  const [list, setList] = useState<{ id: number; node: ReactNode }[]>([]);
  const next = useRef(0);
  const { fail } = useNotice();
  const open = useCallback(
    (make: (close: () => void) => ReactNode) => {
      fail("");
      const id = ++next.current;
      const close = () => setList((l) => l.filter((x) => x.id !== id));
      setList((l) => [...l, { id, node: make(close) }]);
    },
    [fail],
  );
  const sheet = list.map((x) => <Fragment key={x.id}>{x.node}</Fragment>);
  return { sheet, open };
}

/** cancelButton closes the sheet it is in. */
export const CancelButton = ({ onClick }: { onClick: () => void }) => (
  <Button variant="quiet" onClick={onClick}>
    Cancel
  </Button>
);

export interface StepUpField {
  key: string;
  label: string;
  hint?: string;
  attrs?: InputHTMLAttributes<HTMLInputElement>;
  initial?: string;
}

export interface StepUpSheetProps {
  title: string;
  intro?: string;
  fields?: StepUpField[];
  confirm: string;
  action: StepUpAction;
  target?: number | null;
  tone?: "danger";
  /** Runs after the passkey check with its step-up id and the field values; the sheet closes when it resolves. */
  perform: (stepId: string, values: Record<string, string>) => Promise<void>;
  close: () => void;
}

/**
 * StepUpSheet asks for one passkey check and then runs `perform`. The check's options are fetched when the sheet opens;
 * the confirm button waits for them. A failure shows in the sheet and the next tap is a fresh check.
 */
export function StepUpSheet({ title, intro, fields = [], confirm, action, target = null, tone, perform, close }: StepUpSheetProps) {
  const [alert, setAlert] = useState("");
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(fields.map((f) => [f.key, f.initial ?? ""])));
  const [t] = useState(() => stepUpTicket(action, target, (err) => setAlert(humanError(err))));
  const open = useRef(true);
  useEffect(() => {
    t.refresh();
    return () => {
      open.current = false;
      t.drop();
    };
  }, [t]);
  const ceremony = useCeremony(
    t,
    async () => {
      const stepId = await finishStepUp(t.use());
      await perform(stepId, values);
      close();
    },
    { fail: setAlert, alive: () => open.current },
  );
  return (
    <Sheet
      title={title}
      alert={alert}
      onClose={close}
      actions={
        <>
          <Button variant={tone === "danger" ? "danger" : "primary"} type="submit" {...ceremony}>
            {confirm}
          </Button>
          <CancelButton onClick={close} />
        </>
      }
    >
      {intro ? <p className="muted">{intro}</p> : null}
      {fields.map((f) => (
        <Field
          key={f.key}
          label={f.label}
          hint={f.hint}
          {...f.attrs}
          value={values[f.key]}
          onChange={(event) => setValues((v) => ({ ...v, [f.key]: event.target.value }))}
        />
      ))}
    </Sheet>
  );
}
