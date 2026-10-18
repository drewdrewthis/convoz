import { Sheet } from "@convoz/ui/Sheet";
import { useEffect, useState } from "react";

/** How long the sheet is shown before Send works, so a tap meant for something under it cannot confirm (click-jacking, §5.7). */
const ARM_MS = 500;

export interface ConfirmProps {
  /** "@devtool": the agent whose app made the result. */
  agent: string;
  summary: string;
  /** The labelled values: (label, text). The host flattens a frame's value into at most 20 of them. */
  rows: [string, string][];
  /** Resolves true when the owner sent it, false for Cancel and Escape. */
  onDone(sent: boolean): void;
  /** Runs the send; an error text shows in the sheet and the sheet stays. */
  send(): Promise<string | null>;
}

/**
 * ConfirmSheet is the host's confirm sheet (I-46): drawn outside the app's frame, showing exactly what will be sent as the owner.
 * Only a trusted click on Send, after the sheet has been up for 500 ms, sends. An app can fill it and never press it.
 */
export function ConfirmSheet({ agent, summary, rows, onDone, send }: ConfirmProps) {
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [alert, setAlert] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setArmed(true), ARM_MS);
    return () => clearTimeout(t);
  }, []);
  // While the send runs the sheet is gone, so it cannot still be on screen when the posted message shows (the live frame can beat the POST's reply). A failure brings it back with the error.
  if (busy) return null;
  return (
    <Sheet
      title="Confirm app result"
      alert={alert}
      onClose={() => onDone(false)}
      actions={
        <>
          <button className="btn quiet" type="button" onClick={() => onDone(false)}>
            Cancel
          </button>
          <button
            className="btn primary"
            type="button"
            disabled={!armed}
            onClick={async (e) => {
              if (!e.nativeEvent.isTrusted) return;
              setBusy(true);
              const failed = await send();
              if (failed === null) return onDone(true);
              setAlert(failed);
              setBusy(false);
            }}
          >
            Send
          </button>
        </>
      }
    >
      <p>{`Send as you, via app by @${agent}`}</p>
      <p style={{ fontWeight: 600, overflowWrap: "anywhere" }}>{summary}</p>
      <dl style={{ margin: 0 }}>
        {rows.slice(0, 20).map(([k, v], i) => (
          <div key={i} style={{ display: "flex", justifyContent: "space-between", gap: 12, padding: "4px 0", borderTop: "1px solid var(--color-border)" }}>
            <dt style={{ color: "var(--color-muted)" }}>{k}</dt>
            <dd style={{ margin: 0, overflowWrap: "anywhere", textAlign: "right" }}>{v}</dd>
          </div>
        ))}
      </dl>
    </Sheet>
  );
}

/** rowsOf flattens a frame's value into "key: value" rows of plain text, each cut at 120 characters. */
export function rowsOf(value: unknown): [string, string][] {
  const out: [string, string][] = [];
  const cut = (s: string) => (s.length > 120 ? `${s.slice(0, 119)}…` : s);
  const walk = (v: unknown, path: string) => {
    if (out.length >= 20) return;
    if (v !== null && typeof v === "object") {
      const entries = Array.isArray(v) ? v.map((x, i) => [String(i), x] as const) : Object.entries(v);
      if (entries.length === 0) return void out.push([path || "value", Array.isArray(v) ? "[]" : "{}"]);
      for (const [k, x] of entries) walk(x, path ? `${path}.${k}` : k);
      return;
    }
    out.push([path || "value", cut(String(v))]);
  };
  walk(value, "");
  return out;
}
