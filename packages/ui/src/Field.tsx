import { useId, type HTMLInputTypeAttribute, type InputHTMLAttributes, type ReactNode } from "react";
import { cx } from "./cx.ts";
import { ListRow } from "./ListRow.tsx";

interface Own {
  label: string;
}

export interface TextFieldProps extends Own, Omit<InputHTMLAttributes<HTMLInputElement>, "type"> {
  type?: Exclude<HTMLInputTypeAttribute, "checkbox" | "radio" | "time">;
  hint?: string;
  /** The text is set in the monospace face, as a code is. */
  mono?: boolean;
}

export interface ChoiceFieldProps extends Own, Omit<InputHTMLAttributes<HTMLInputElement>, "type"> {
  type: "checkbox" | "radio" | "time";
  /** What the field draws. label (the default): a row of a List, the label on the left and the control on the right. li: the same as a list item of its own, so only the label text and the control are the target of a tap. check: the control first, then the label, with no row around it. */
  as?: "label" | "li" | "check";
}

export type FieldProps = TextFieldProps | ChoiceFieldProps;

const isChoice = (props: FieldProps): props is ChoiceFieldProps => props.type === "checkbox" || props.type === "radio" || props.type === "time";

const checkLine = "flex min-h-48 items-center gap-12 text-15 font-medium text-text";
const checkBox = "size-24 flex-none accent-accent";

function Choice({ label, as = "label", id: given, ...input }: Omit<ChoiceFieldProps, "type"> & { type: ChoiceFieldProps["type"] }): ReactNode {
  const auto = useId();
  const id = given ?? auto;
  const control = <input {...input} id={id} className={as === "check" ? checkBox : undefined} />;
  if (as === "li")
    return (
      <ListRow as="li" trailing={control}>
        <label htmlFor={id} className="min-w-0 grow text-13 font-semibold text-muted">
          {label}
        </label>
      </ListRow>
    );
  if (as === "check")
    return (
      <label className={checkLine}>
        {control}
        <span>{label}</span>
      </label>
    );
  return <ListRow as="label" title={label} trailing={control} />;
}

/**
 * Field is a labelled input. A text field is a label above a one-line input, with an optional hint under it; typing aids are off unless
 * asked for. A checkbox, a radio or a time field is the label with the control beside it (see `as`), as a row of a List.
 */
export function Field(props: FieldProps) {
  const auto = useId();
  if (isChoice(props)) return <Choice {...props} />;
  const { label, hint, mono, type = "text", className, ...input } = props as TextFieldProps;
  return (
    <div className="field">
      <label htmlFor={input.id ?? auto}>{label}</label>
      <input id={auto} name={auto} type={type} autoComplete="off" autoCapitalize="off" autoCorrect="off" spellCheck={false} {...input} className={cx(mono && "font-mono", className)} />
      {hint ? <p className="hint">{hint}</p> : null}
    </div>
  );
}
