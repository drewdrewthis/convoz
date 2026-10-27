import type { Identity } from "@convoz/api-client";
import { stripCf } from "../../shared/chat.ts";

/** Lower is closer: exact 0, prefix 1, start of a word 2, letters in order 3; -1 when the text does not match. */
function rank(text: string, typed: string): number {
  const t = text.toLowerCase();
  if (t === typed) return 0;
  if (t.startsWith(typed)) return 1;
  if (t.split(/[^a-z0-9]+/).some((w) => w.startsWith(typed))) return 2;
  let at = 0;
  for (const ch of t) if (ch === typed[at] && ++at === typed.length) return 3;
  return -1;
}

/** The people whose handle or display name matches what was typed after "@", the closest first (ties keep the crew's order). */
export function fuzzyMatch(crew: Identity[], typed: string): Identity[] {
  if (!typed) return crew;
  return crew
    .map((who, order) => {
      const ranks = [rank(who.handle, typed), rank(stripCf(who.display_name), typed)].filter((r) => r >= 0);
      return { who, order, best: ranks.length ? Math.min(...ranks) : -1 };
    })
    .filter((m) => m.best >= 0)
    .sort((a, b) => a.best - b.best || a.order - b.order)
    .map((m) => m.who);
}
