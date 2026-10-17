import type { Allow } from "@convoz/api-client";

/** parseAllow reads "dev-*, docs" as an allow-list: names are identities, anything with * or ? is a pattern. */
export function parseAllow(text: string): Allow {
  const entries = text.split(",").map((e) => e.trim()).filter(Boolean);
  return { mode: "list", identities: entries.filter((e) => !/[*?]/.test(e)), globs: entries.filter((e) => /[*?]/.test(e)) };
}

/** allowText says an allow-list in words. */
export const allowText = (allow: Allow): string => (allow.mode === "any" ? "any agent" : [...allow.identities, ...allow.globs].join(", ") || "no agent");
