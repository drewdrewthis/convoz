// The plan pieces the details panel (PlanSections.tsx) draws: the message that asks an agent for its plan, a Now item and its step bar.
import type { Plan } from "@convoz/api-client";
import { span, when } from "../plan/index.ts";

/**
 * planRequest is the message "Ask for a plan" and "Ask for an update" post: it says how to set the plan, not only to share one,
 * so the agent runs `convoz plan` and the panel fills, instead of writing the plan as a chat message (owner msg 594).
 */
export function planRequest(handle: string, conv: number, kind: "share" | "update"): string {
  const ask = kind === "share" ? "please set your plan for this conversation" : "please update your plan for this conversation";
  return `@${handle}, ${ask}. Use \`convoz plan ${conv}\`, not a chat message, so it shows in the panel:\n\n\`\`\`\nconvoz plan ${conv} --doing "what you do now" --eta 30m --next "then this" --next "then that" --done "what you finished"\n\`\`\`\n\nAdd \`--waiting "what you need from me"\` or \`--blocked "what stops you"\` if any. Up to 3 things at once? Repeat \`--doing\`, each with its own \`--eta\` and \`--step\`. Keep it current as you work. With MCP, use the \`plan\` tool. See \`convoz plan --help\`.`;
}

/** StepBar is "step N of M" as a row of segments, up to 12 (a longer plan is shown to scale). */
function StepBar({ at, of }: { at: number; of: number }) {
  const n = Math.min(of, 12);
  const on = Math.round((at / of) * n);
  return (
    <span className="pstep">
      <span className="pbar" role="img" aria-label={`Step ${at} of ${of}`}>
        {Array.from({ length: n }, (_, i) => (
          <i key={i} data-on={i < on || undefined} />
        ))}
      </span>
      <span aria-hidden="true">{`${at} of ${of}`}</span>
    </span>
  );
}

/** NowBlock is one Now item: its title, its step bar and one muted line of times. Each parallel item has its own (owner msg 659). */
export function NowBlock({ item, now }: { item: NonNullable<Plan["now"]>[number]; now: number }) {
  const late = Boolean(item.eta && now >= item.eta);
  const meta = [item.since ? `Started ${when(item.since, now)}` : "", item.eta && !late ? `ready ~${when(item.eta, now)}` : ""].filter(Boolean).join(" · ");
  return (
    <div className="pnow">
      <p className="plbl">Now</p>
      <p className="pwhat">{item.text}</p>
      {item.step ? <StepBar at={item.step.at} of={item.step.of} /> : null}
      {late ? <p className="pwhen amber">{`Was due ${when(item.eta!, now)} · ${span(now - item.eta!)} late`}</p> : meta ? <p className="pwhen">{meta}</p> : null}
    </div>
  );
}

