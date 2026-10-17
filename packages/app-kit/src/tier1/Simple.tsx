import { useState } from "react";
import type { ChecklistProps, AppContext, KvProps, ProgressProps } from "../types.ts";
import { box, muted, toneColor } from "./tone.ts";

/** Kv shows key and value pairs. */
export function Kv({ props }: { props: KvProps }) {
  return (
    <dl style={{ ...box, margin: 0, display: "grid", gridTemplateColumns: props.columns === 2 ? "1fr 1fr" : "1fr", gap: "8px 16px" }}>
      {props.pairs.map((p, i) => (
        <div key={i} style={{ display: "flex", justifyContent: "space-between", gap: 12, borderBottom: "1px solid var(--color-border)", paddingBottom: 4 }}>
          <dt style={muted}>{p.k}</dt>
          <dd style={{ margin: 0, fontWeight: 600, color: toneColor(p.tone, "var(--color-text)") }}>{String(p.v)}</dd>
        </div>
      ))}
    </dl>
  );
}

const STEP: Record<string, string> = { todo: "to do", doing: "in progress", done: "done", failed: "failed", skipped: "skipped" };

/** Progress is a bar (value, or done of total) and a list of steps. */
export function Progress({ props }: { props: ProgressProps }) {
  const frac = props.value ?? (props.total ? (props.done ?? 0) / props.total : undefined);
  const text = props.total ? `${props.done ?? 0} of ${props.total}` : frac === undefined ? "" : `${Math.round(frac * 100)}%`;
  return (
    <div style={box}>
      {props.label ? <div style={{ fontWeight: 600, marginBottom: 6 }}>{props.label}</div> : null}
      {frac !== undefined ? (
        <>
          <div role="progressbar" aria-label={props.label ?? "Progress"} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(frac * 100)} aria-valuetext={text} style={{ height: 8, borderRadius: 4, background: "var(--color-border)", overflow: "hidden" }}>
            <div style={{ width: `${frac * 100}%`, height: "100%", background: toneColor(props.tone) }} />
          </div>
          <div style={{ fontSize: 12, marginTop: 4, ...muted }}>{text}</div>
        </>
      ) : null}
      {props.steps ? (
        <ol style={{ margin: "8px 0 0", paddingLeft: 18 }}>
          {props.steps.map((s, i) => (
            <li key={i} data-step={s.state}>
              {s.label} <span style={muted}>{STEP[s.state]}</span>
            </li>
          ))}
        </ol>
      ) : null}
    </div>
  );
}

/** Checklist: view mode is read-only; select mode lets the viewer tick and Send, and the host shows the sheet. */
export function Checklist({ props, ctx }: { props: ChecklistProps; ctx: AppContext }) {
  const select = props.mode === "select";
  const [ticked, setTicked] = useState(() => new Set(props.items.filter((i) => i.done).map((i) => i.id)));
  const count = ticked.size;
  const min = props.minChecked ?? 0;
  return (
    <div style={box}>
      <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 4 }}>
        {props.items.map((it) => (
          <li key={it.id}>
            <label style={{ display: "flex", alignItems: "center", gap: 8, minHeight: select ? 36 : undefined }}>
              <input
                type="checkbox"
                checked={select ? ticked.has(it.id) : it.done}
                readOnly={!select}
                disabled={!select}
                onChange={() =>
                  setTicked((s) => {
                    const n = new Set(s);
                    if (!n.delete(it.id)) n.add(it.id);
                    return n;
                  })
                }
              />
              <span>{it.label}</span>
              {it.note ? <span style={{ fontSize: 12, ...muted }}>{it.note}</span> : null}
            </label>
          </li>
        ))}
      </ul>
      {select && !ctx.onAsk ? (
        <button
          type="button"
          className="btn small"
          disabled={count < min}
          style={{ marginTop: 8 }}
          onClick={() => {
            const checked = props.items.filter((i) => ticked.has(i.id)).map((i) => i.id);
            ctx.onResult({ source: "checklist", summary: `Ticked ${checked.length} of ${props.items.length}: ${props.items.filter((i) => ticked.has(i.id)).map((i) => i.label).join(", ") || "none"}`.slice(0, 280), value: { checked } });
          }}
        >
          {props.submitLabel ?? "Send"}
        </button>
      ) : null}
    </div>
  );
}
