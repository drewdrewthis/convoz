import type { Ask } from "@convoz/api-client";

/** askFrame is what an ask shows in the one item layout (owner, conv 179 msg 11603, 12448, 12807, 12813): the action is the title, and the risk, the undo, the other ways or the recommendation are the context. */
export function askFrame(ask: Ask, by: string): { title: string; context: string } {
  if (ask.draft) return { title: ask.question, context: [`Draft: ${ask.draft.text}`, `Asked by ${by}`].join(". ") };
  const p = ask.permission;
  if (p) {
    const undo = p.one_way ? "None. This is one-way." : (p.undo ?? "");
    const other = p.considered.length ? `Considered: ${p.considered.join("; ")}.` : "";
    return { title: p.action, context: [`Risk: ${p.risk}.`, `Undo: ${undo}`, other, `Asked by ${by}`].filter(Boolean).join(" ") };
  }
  const why = ask.answers || ask.options[0]?.why || "";
  const recommended = ask.options[0]?.label;
  return { title: ask.question, context: [recommended ? `Recommended: ${recommended}` : "", why, `Asked by ${by}`].filter(Boolean).join(". ") };
}

/** okayAnswer is what Okay says for an ask: the recommended option, or, for a draft, the draft as written (Send). */
export function okayAnswer(ask: Ask): { choice: "recommended"; text?: string } {
  return ask.draft ? { choice: "recommended", text: ask.draft.text } : { choice: "recommended" };
}

/** carriesApp is whether an agent attached an app to the ask; the item draws it under the context (owner, conv 179 msg 12448). */
export const carriesApp = (ask: Ask): boolean => Boolean(ask.app);

/** doneLine is the one line of a closed ask in its item: "Go, by drew", "Dismissed" or "Closed"; empty for an open ask. */
export function doneLine(ask: Ask): string {
  if (ask.state === "dismissed") return "Dismissed";
  if (ask.state === "closed") return "Closed";
  if (ask.state !== "answered") return "";
  const said = ask.permission && !ask.draft ? (ask.chosen?.kind === "recommended" ? "Go" : ask.chosen?.kind === "custom" ? `Replied: ${ask.answer ?? ""}` : "Not this") : (ask.answer ?? "Answered");
  const by = ask.resolved_by?.handle;
  return by ? `${said}, by ${by}` : said;
}

/**
 * openReply is Reply on an ask in its conversation: it follows #reply=<root>, which the conversation page follows by loading back to the
 * root, scrolling to it and opening its reply box (Conversation.tsx). A bare startReply did nothing for the card in "Waiting on you",
 * whose root may be far back and not drawn (owner, conv 179 msg 13541). The same hash again fires no hashchange, so it is sent by hand.
 */
export function openReply(ask: Pick<Ask, "id" | "thread_root_id">, page: { location: { hash: string }; dispatchEvent(e: Event): boolean } = window): void {
  const hash = `#reply=${ask.thread_root_id ?? ask.id}`;
  const same = page.location.hash === hash;
  page.location.hash = hash;
  if (same) page.dispatchEvent(new Event("hashchange"));
}
