import type { Ask } from "@convoz/api-client";

/** askFrame is what an ask shows in the one item layout (owner, conv 179 msg 11603, 12448, 12807, 12813): the action is the title, and the risk, the undo, the other ways or the recommendation are the context. */
export function askFrame(ask: Ask, by: string): { title: string; context: string } {
  const p = ask.permission;
  if (p && !ask.draft) {
    const undo = p.one_way ? "None. This is one-way." : (p.undo ?? "");
    const other = p.considered.length ? `Considered: ${p.considered.join("; ")}.` : "";
    return { title: p.action, context: [`Risk: ${p.risk}.`, `Undo: ${undo}`, other, `Asked by ${by}`].filter(Boolean).join(" ") };
  }
  const why = ask.answers || ask.options[0]?.why || "";
  const recommended = ask.options[0]?.label;
  return { title: ask.question, context: [recommended ? `Recommended: ${recommended}` : "", why, `Asked by ${by}`].filter(Boolean).join(". ") };
}
