import { isTriage } from "./chat.ts";

/** TriageBadge marks a triage agent wherever an agent's name is shown (owner, msg 1217). It renders nothing for any other handle. */
export function TriageBadge({ handle }: { handle: string }) {
  if (!isTriage(handle)) return null;
  return <span role="img" aria-label="Triage agent" className="inline-flex flex-none items-center rounded-full bg-soft px-6 text-12 font-semibold text-accent-text">Triage</span>;
}
