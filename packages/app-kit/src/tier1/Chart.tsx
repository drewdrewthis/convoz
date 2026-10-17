import type { ChartProps } from "../types.ts";
import { box, muted, toneColor } from "./tone.ts";

const pct = (x: number) => `${Math.max(0, Math.min(100, x * 100)).toFixed(2)}%`;

/** Chart is a bar, line or spark chart with reference lines. Hovering a mark only shows its value; nothing here answers anything. */
export function Chart({ props, title, height }: { props: ChartProps; title?: string; height?: number }) {
  const { kind, series, refLines = [], stacked } = props;
  const labels = props.x?.labels ?? [];
  const n = Math.max(...series.map((s) => s.values.length));
  const unit = props.y?.unit ?? "";
  const stackTotals = Array.from({ length: n }, (_, i) => series.reduce((a, s) => a + (s.values[i] ?? 0), 0));
  const all = stacked ? stackTotals : series.flatMap((s) => s.values.filter((v): v is number => v !== null));
  const lo = props.y?.min ?? Math.min(0, ...all);
  const hi = props.y?.max ?? (Math.max(...all, ...refLines.map((r) => r.value)) * 1.08 || 1);
  const at = (v: number) => (v - lo) / (hi - lo || 1);
  const plot = height ? Math.max(60, height - 70) : 140;
  const label = (i: number, s: ChartProps["series"][number]) => `${labels[i] ?? `Point ${i + 1}`}: ${s.name} ${s.values[i] ?? "no value"}${unit}`;

  return (
    <div data-chart={kind} style={box}>
      <div role="img" aria-label={title ?? "Chart"} style={{ position: "relative", height: plot, borderBottom: "1px solid var(--color-border)" }}>
        {kind === "bar" ? (
          <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "flex-end", gap: 6, padding: "0 4px" }}>
            {Array.from({ length: n }, (_, i) => (
              <div key={i} style={{ flex: 1, height: "100%", display: "flex", alignItems: "flex-end", gap: 2, flexDirection: stacked ? "column-reverse" : "row" }}>
                {series.map((s) => {
                  const v = s.values[i] ?? 0;
                  return (
                    <div
                      key={s.name}
                      data-bar={`${s.name}:${i}`}
                      title={label(i, s)}
                      style={{ flex: stacked ? "none" : 1, width: stacked ? "100%" : undefined, height: pct(stacked ? v / (hi - lo) : at(v)), background: toneColor(s.tone, s === series[0] ? "var(--color-accent)" : "var(--color-muted)"), borderRadius: "3px 3px 0 0", minHeight: 1 }}
                    />
                  );
                })}
              </div>
            ))}
          </div>
        ) : (
          <svg viewBox="0 0 100 100" preserveAspectRatio="none" width="100%" height="100%" aria-hidden="true" style={{ position: "absolute", inset: 0 }}>
            {series.map((s, si) => {
              const pts = s.values.map((v, i) => (v === null ? null : `${n > 1 ? (i / (n - 1)) * 100 : 50},${100 - at(v) * 100}`)).filter(Boolean);
              const color = toneColor(s.tone, si === 0 ? "var(--color-accent)" : "var(--color-muted)");
              return (
                <g key={s.name}>
                  {kind === "spark" ? <polygon points={`0,100 ${pts.join(" ")} 100,100`} fill={color} opacity="0.12" /> : null}
                  <polyline points={pts.join(" ")} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
                </g>
              );
            })}
          </svg>
        )}
        {refLines.map((r) => (
          <div key={r.label} data-refline={r.label} style={{ position: "absolute", left: 0, right: 0, bottom: pct(at(r.value)), borderTop: `2px dashed ${toneColor(r.tone, "var(--color-warning)")}` }}>
            <span style={{ position: "absolute", right: 0, bottom: 2, fontSize: 12, color: toneColor(r.tone, "var(--color-warning)"), background: "var(--color-raised)", padding: "0 4px" }}>{r.label}</span>
          </div>
        ))}
      </div>
      {kind !== "spark" && labels.length ? (
        <div aria-hidden="true" style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginTop: 4, ...muted }}>
          {labels.map((l, i) => (
            <span key={i} style={{ flex: 1, textAlign: "center" }}>
              {l}
            </span>
          ))}
        </div>
      ) : null}
      <ul style={{ display: "flex", flexWrap: "wrap", gap: "2px 12px", margin: "6px 0 0", padding: 0, listStyle: "none", fontSize: 12, ...muted }}>
        {series.map((s, si) => (
          <li key={s.name}>
            <span aria-hidden="true" style={{ display: "inline-block", width: 8, height: 8, borderRadius: 4, marginRight: 4, background: toneColor(s.tone, si === 0 ? "var(--color-accent)" : "var(--color-muted)") }} />
            {s.name}
          </li>
        ))}
        {kind === "spark" ? <li>{`Peak ${Math.max(...all)}${unit}`}</li> : null}
      </ul>
    </div>
  );
}
