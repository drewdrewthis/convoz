import { useState } from "react";
import type { TableProps } from "../types.ts";
import { box, muted } from "./tone.ts";

/** Table is a sortable table. Sorting is the viewer's own view and sends nothing. */
export function Table({ props, title }: { props: TableProps; title?: string }) {
  const [sort, setSort] = useState<{ col: number; dir: 1 | -1 } | null>(null);
  const rows = props.rows.map((r, i) => ({ r, i }));
  if (sort) {
    const { col, dir } = sort;
    rows.sort((a, b) => {
      const x = a.r[col] ?? "";
      const y = b.r[col] ?? "";
      return (typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y))) * dir;
    });
  }
  return (
    <div style={{ ...box, overflowX: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <caption style={{ textAlign: "left", paddingBottom: 6, ...muted }}>{props.caption ?? title ?? ""}</caption>
        <thead>
          <tr>
            {props.columns.map((c, ci) => {
              const on = sort?.col === ci;
              const align = c.align ?? (c.kind === "number" ? "right" : "left");
              return (
                <th key={ci} scope="col" aria-sort={on ? (sort!.dir > 0 ? "ascending" : "descending") : props.sortable ? "none" : undefined} style={{ textAlign: align, borderBottom: "1px solid var(--color-border)", padding: "2px 8px 6px 0", fontSize: 12, ...muted }}>
                  {props.sortable ? (
                    <button type="button" onClick={() => setSort({ col: ci, dir: on && sort!.dir > 0 ? -1 : 1 })} style={{ minHeight: 28, padding: 0, border: 0, background: "none", font: "inherit", color: "inherit", fontWeight: 600 }}>
                      {c.label}
                      {on ? (sort!.dir > 0 ? " ▲" : " ▼") : ""}
                    </button>
                  ) : (
                    c.label
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {rows.map(({ r, i }) => (
            <tr key={i} aria-current={props.highlightRow === i ? "true" : undefined} style={{ background: props.highlightRow === i ? "var(--color-soft)" : "transparent" }}>
              {r.map((cell, ci) => (
                <td key={ci} style={{ textAlign: props.columns[ci]?.align ?? (props.columns[ci]?.kind === "number" ? "right" : "left"), padding: "6px 8px 6px 0", borderBottom: "1px solid var(--color-border)", fontWeight: ci === 0 ? 600 : 400 }}>
                  {cell === null ? "" : String(cell)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
