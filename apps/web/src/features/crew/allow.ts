import type { Allow } from "@convoz/api-client";

/** parseAllow reads "dev-*, docs" as an allow-list: names are identities, anything with * or ? is a pattern. */
export function parseAllow(text: string): Allow {
  const entries = text.split(",").map((e) => e.trim()).filter(Boolean);
  return { mode: "list", identities: entries.filter((e) => !/[*?]/.test(e)), globs: entries.filter((e) => /[*?]/.test(e)) };
}

/** allowText says an allow-list in words. */
export const allowText = (allow: Allow): string => (allow.mode === "any" ? "any agent" : [...allow.identities, ...allow.globs].join(", ") || "no agent");

/** admits says whether a machine with this allow-list may speak for the handle. */
export function admits(allow: Allow, handle: string): boolean {
  if (allow.mode === "any") return true;
  if (allow.identities.includes(handle)) return true;
  return allow.globs.some((g) => new RegExp(`^${g.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`).test(handle));
}
