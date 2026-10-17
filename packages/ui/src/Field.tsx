import { useId, type InputHTMLAttributes } from "react";

export interface FieldProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string;
  hint?: string;
}

/** Field is a label above a one-line text input, with an optional hint under it. Typing aids are off unless asked for. */
export function Field({ label, hint, ...input }: FieldProps) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input id={id} name={id} type="text" autoComplete="off" autoCapitalize="off" autoCorrect="off" spellCheck={false} {...input} />
      {hint ? <p className="hint">{hint}</p> : null}
    </div>
  );
}
