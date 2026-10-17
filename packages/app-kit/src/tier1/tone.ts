import type { Tone } from "../types.ts";

/** The colour of a tone token. An app names a tone, never a colour (schemas: no raw colours). */
export const toneColor = (t: Tone | undefined, fallback = "var(--color-accent)"): string => {
  switch (t) {
    case "muted":
      return "var(--color-muted)";
    case "good":
      return "var(--color-success)";
    case "warn":
      return "var(--color-warning)";
    case "bad":
      return "var(--color-danger)";
    case "default":
      return "var(--color-text)";
    default:
      return fallback;
  }
};

export const box = { padding: "10px 12px", boxSizing: "border-box" as const, fontSize: 13 };
export const muted = { color: "var(--color-muted)" };
