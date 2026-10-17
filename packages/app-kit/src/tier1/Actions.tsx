import { useState, type CSSProperties } from "react";
import type { AppContext, FormField, FormProps, PickerProps } from "../types.ts";
import { box, muted } from "./tone.ts";

const chip = (on: boolean): CSSProperties => ({ minHeight: 36, padding: "0 14px", border: `1px solid ${on ? "var(--color-accent)" : "var(--color-border)"}`, borderRadius: 999, background: on ? "var(--color-soft)" : "transparent", color: "var(--color-text)", font: "inherit", fontWeight: 500 });

/** Picker: a single picker answers with one tap on an option (the tap is the owner's gesture); a multi picker ticks, then Send opens the host sheet. */
export function Picker({ props, title, ctx }: { props: PickerProps; title?: string; ctx: AppContext }) {
  const [sel, setSel] = useState<string[]>([]);
  const label = (id: string) => props.options.find((o) => o.id === id)?.label ?? id;
  const live = !ctx.onAsk;
  if (!props.multi) {
    return (
      <div role="group" aria-label={title ?? props.prompt ?? "Choose one"} style={{ ...box, display: "flex", flexDirection: "column", gap: 8 }}>
        {props.prompt ? <span style={muted}>{props.prompt}</span> : null}
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          {props.options.map((o) => (
            <button key={o.id} type="button" title={o.hint} disabled={!live} style={chip(false)} onClick={() => ctx.onResult({ source: "picker", summary: `Picked ${o.label}`, value: { selected: [o.id] }, direct: true })}>
              {o.label}
            </button>
          ))}
        </div>
      </div>
    );
  }
  const max = props.max ?? props.options.length;
  const min = props.min ?? 1;
  return (
    <div role="group" aria-label={title ?? props.prompt ?? "Choose"} style={{ ...box, display: "flex", flexDirection: "column", gap: 8 }}>
      {props.prompt ? <span style={muted}>{props.prompt}</span> : null}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        {props.options.map((o) => {
          const on = sel.includes(o.id);
          return (
            <button key={o.id} type="button" aria-pressed={on} title={o.hint} disabled={!live || (!on && sel.length >= max)} style={chip(on)} onClick={() => setSel((s) => (on ? s.filter((x) => x !== o.id) : [...s, o.id]))}>
              {o.label}
            </button>
          );
        })}
      </div>
      {live ? (
        <button type="button" className="btn small" style={{ alignSelf: "flex-start" }} disabled={sel.length < min} onClick={() => ctx.onResult({ source: "picker", summary: `Picked ${sel.map(label).join(", ")}`, value: { selected: sel }, rows: [["Picked", sel.map(label).join(", ")]] })}>
          {props.submitLabel ?? "Send"}
        </button>
      ) : null}
    </div>
  );
}

type Values = Record<string, string | number | boolean | null>;
const initial = (f: FormField): string | number | boolean | null => {
  if (f.default !== undefined) return f.default as string | number | boolean;
  return f.kind === "toggle" ? false : f.kind === "number" ? null : f.kind === "select" ? "" : "";
};

/** Form: host-drawn fields. Submit opens the host sheet with every value; only Send in the sheet posts. */
export function Form({ props, title, ctx }: { props: FormProps; title?: string; ctx: AppContext }) {
  const [v, setV] = useState<Values>(() => Object.fromEntries(props.fields.map((f) => [f.id, initial(f)])));
  const [err, setErr] = useState("");
  const show = (f: FormField): string => {
    const x = v[f.id];
    if (f.kind === "toggle") return x ? "Yes" : "No";
    if (f.kind === "select") return f.options?.find((o) => o.id === x)?.label ?? "";
    return x === null || x === "" ? "(empty)" : String(x);
  };
  const submit = () => {
    const missing = props.fields.find((f) => f.required && (v[f.id] === "" || v[f.id] === null));
    if (missing) return setErr(`${missing.label} is required.`);
    setErr("");
    const fields: Values = {};
    for (const f of props.fields) fields[f.id] = f.kind === "select" && v[f.id] === "" ? null : v[f.id]!;
    ctx.onResult({ source: "form", summary: `${title ?? "Form"}: ${props.fields.map((f) => `${f.label} ${show(f)}`).join("; ")}`.slice(0, 280), value: { fields }, rows: props.fields.map((f) => [f.label, show(f)]) });
  };
  const input = (f: FormField) => {
    const id = `f-${f.id}`;
    const common = { id, name: f.id, required: f.required, disabled: !!ctx.onAsk };
    switch (f.kind) {
      case "textarea":
        return <textarea {...common} placeholder={f.placeholder} maxLength={f.maxLength} value={String(v[f.id] ?? "")} onChange={(e) => setV({ ...v, [f.id]: e.target.value })} />;
      case "number":
        return <input {...common} type="number" min={f.min} max={f.max} step={f.step} value={v[f.id] === null ? "" : String(v[f.id])} onChange={(e) => setV({ ...v, [f.id]: e.target.value === "" ? null : Number(e.target.value) })} />;
      case "select":
        return (
          <select {...common} value={String(v[f.id] ?? "")} onChange={(e) => setV({ ...v, [f.id]: e.target.value })}>
            {f.required ? null : <option value="" />}
            {f.options?.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </select>
        );
      case "toggle":
        return <input {...common} type="checkbox" checked={!!v[f.id]} onChange={(e) => setV({ ...v, [f.id]: e.target.checked })} />;
      case "date":
        return <input {...common} type="date" value={String(v[f.id] ?? "")} onChange={(e) => setV({ ...v, [f.id]: e.target.value })} />;
      default:
        return <input {...common} type="text" placeholder={f.placeholder} maxLength={f.maxLength} value={String(v[f.id] ?? "")} onChange={(e) => setV({ ...v, [f.id]: e.target.value })} />;
    }
  };
  return (
    <form noValidate aria-label={title ?? "Form"} onSubmit={(e) => { e.preventDefault(); submit(); }} style={{ ...box, display: "flex", flexDirection: "column", gap: 10 }}>
      {props.intro ? <p style={{ margin: 0, ...muted }}>{props.intro}</p> : null}
      {props.fields.map((f) => (
        <div key={f.id} style={{ display: "flex", flexDirection: f.kind === "toggle" ? "row" : "column", gap: 4, alignItems: f.kind === "toggle" ? "center" : undefined }}>
          <label htmlFor={`f-${f.id}`} style={{ fontWeight: 600 }}>
            {f.label}
          </label>
          {input(f)}
          {f.help ? <span style={{ fontSize: 12, ...muted }}>{f.help}</span> : null}
        </div>
      ))}
      {err ? <p role="alert" style={{ margin: 0, color: "var(--color-danger)" }}>{err}</p> : null}
      {!ctx.onAsk ? (
        <button type="submit" className="btn small" style={{ alignSelf: "flex-start" }}>
          {props.submitLabel}
        </button>
      ) : null}
    </form>
  );
}
