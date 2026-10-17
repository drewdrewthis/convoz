import { useMemo, useState } from "react";
import type { CodeProps } from "../types.ts";
import { box, muted } from "./tone.ts";

interface DiffFile {
  name: string;
  add: number;
  del: number;
  lines: { k: "add" | "del" | "ctx" | "hunk"; text: string }[];
}

/** parseDiff reads a unified diff into files and lines. It returns null when the text is not one, and the raw text is shown. */
export function parseDiff(text: string): DiffFile[] | null {
  const files: DiffFile[] = [];
  let cur: DiffFile | null = null;
  for (const raw of text.split("\n")) {
    if (raw.startsWith("+++ ")) {
      cur = { name: raw.slice(4).replace(/^b\//, ""), add: 0, del: 0, lines: [] };
      files.push(cur);
    } else if (raw.startsWith("--- ") || raw.startsWith("diff ") || raw.startsWith("index ")) {
      continue;
    } else if (!cur) {
      continue;
    } else if (raw.startsWith("@@")) {
      cur.lines.push({ k: "hunk", text: raw });
    } else if (raw.startsWith("+")) {
      cur.add++;
      cur.lines.push({ k: "add", text: raw.slice(1) });
    } else if (raw.startsWith("-")) {
      cur.del++;
      cur.lines.push({ k: "del", text: raw.slice(1) });
    } else if (raw !== "") {
      cur.lines.push({ k: "ctx", text: raw.slice(1) });
    }
  }
  return files.length ? files : null;
}

const mono = { fontFamily: "var(--font-mono, monospace)", fontSize: 12, lineHeight: 1.5 };

/** Code shows source text, or a diff as a list of changed files with their +/- lines. Text is drawn as text, never as markup. */
export function Code({ props }: { props: CodeProps }) {
  const files = useMemo(() => (props.mode === "diff" ? parseDiff(props.text) : null), [props.mode, props.text]);
  const [open, setOpen] = useState(0);
  if (!files) {
    const lines = props.text.replace(/\n$/, "").split("\n");
    const start = props.startLine ?? 1;
    return (
      <div style={box}>
        {props.filename ? <div style={{ marginBottom: 4, fontWeight: 600 }}>{props.filename}</div> : null}
        <pre style={{ margin: 0, overflowX: "auto", whiteSpace: props.wrap ? "pre-wrap" : "pre", ...mono }}>
          {props.mode === "code" ? lines.map((l, i) => `${String(start + i).padStart(3, " ")}  ${l}`).join("\n") : props.text}
        </pre>
      </div>
    );
  }
  const f = files[Math.min(open, files.length - 1)]!;
  return (
    <div style={box}>
      <div style={{ fontWeight: 600, marginBottom: 6 }}>Changed files</div>
      <div role="group" aria-label="Changed files" style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 8 }}>
        {files.map((x, i) => (
          <button key={x.name} type="button" aria-pressed={i === open} onClick={() => setOpen(i)} style={{ minHeight: 28, padding: "0 10px", border: "1px solid var(--color-border)", borderRadius: 999, background: i === open ? "var(--color-soft)" : "transparent", color: "var(--color-text)", font: "inherit", fontSize: 12 }}>
            {x.name} <span style={muted}>{`+${x.add} −${x.del}`}</span>
          </button>
        ))}
      </div>
      <div data-diff-file={f.name} style={{ overflowX: "auto", border: "1px solid var(--color-border)", borderRadius: 8 }}>
        {f.lines.map((l, i) => (
          <div key={i} data-line={l.k} style={{ display: "flex", gap: 8, padding: "0 8px", whiteSpace: "pre", background: l.k === "add" ? "color-mix(in srgb, var(--color-success) 14%, transparent)" : l.k === "del" ? "color-mix(in srgb, var(--color-danger) 12%, transparent)" : "transparent", color: l.k === "hunk" ? "var(--color-muted)" : "var(--color-text)", ...mono }}>
            <span aria-hidden="true" style={{ width: 10, color: l.k === "add" ? "var(--color-success)" : l.k === "del" ? "var(--color-danger)" : "var(--color-muted)" }}>
              {l.k === "add" ? "+" : l.k === "del" ? "−" : " "}
            </span>
            <span>{l.text}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
