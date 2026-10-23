// The plan parts of the details panel (the UX pass approved for phase 1): "Waiting on you" (asks and joins) with the action in place, then one card per
// agent (its state, Now with the estimate, Next numbered, Done folded). The "Conversation" settings follow in Details.tsx.
import { Button } from "@convoz/ui/Button";
import type { Conversation, Person, Plan, PlanAgent, PlanBoard } from "@convoz/api-client";
import { ChevronIcon } from "@convoz/ui/icons";
import { useEffect, useRef, useState } from "react";
import { initials, paletteOf, stripCf } from "../../shared/chat.ts";
import { TriageBadge } from "../../shared/TriageBadge.tsx";
import { AskInline, useNow } from "../now/index.ts";
import { ago, clock, dayLabel, span, usePlans, when, type Tone } from "../plan/index.ts";
import { planHash } from "./messages/PlanNote.tsx";

/** What the panel's plan parts can do in the conversation: post a message as the owner, or start one in the composer. */
export interface PlanActions {
  say(text: string): void;
  reply(text: string): void;
}

/**
 * planRequest is the message "Ask for a plan" and "Ask for an update" post: it says how to set the plan, not only to share one,
 * so the agent runs `convoz plan` and the panel fills, instead of writing the plan as a chat message (owner msg 594).
 */
export function planRequest(handle: string, conv: number, kind: "share" | "update"): string {
  const ask = kind === "share" ? "please set your plan for this conversation" : "please update your plan for this conversation";
  return `@${handle}, ${ask}. Use \`convoz plan ${conv}\`, not a chat message, so it shows in the panel:\n\n\`\`\`\nconvoz plan ${conv} --doing "what you do now" --eta 30m --next "then this" --next "then that" --done "what you finished"\n\`\`\`\n\nAdd \`--waiting "what you need from me"\` or \`--blocked "what stops you"\` if any. Up to 3 things at once? Repeat \`--doing\`, each with its own \`--eta\` and \`--step\`. Keep it current as you work. With MCP, use the \`plan\` tool. See \`convoz plan --help\`.`;
}

/** planUpdateRequest is the message "Request plan update" posts: the agent brings its plan in the panel up to date. */
export function planUpdateRequest(handle: string, conv: number): string {
  return `@${handle}, please update your plan for this conversation with \`convoz plan ${conv}\`: what you do now (with \`--eta\`), what comes next, what you finished, and \`--waiting\` or \`--blocked\` if any. See \`convoz plan --help\`.`;
}

/** miniAppRequest is the message "Request mini app" posts: what a mini app is, when it helps, and how to make a good one. */
export function miniAppRequest(handle: string): string {
  return `@${handle}, please make a mini app for this instead of more text.\n\nA mini app is a small web page you post in the chat; it opens in place. It beats a wall of text when I must compare options, see a layout or a flow, check numbers, or click through choices.\n\nHow:\n\n\`\`\`\nconvoz app init ./my-app      # makes the starter files\nconvoz app build ./my-app     # builds app.html and app.json\nconvoz app validate ./my-app/dist/app.html\n\`\`\`\n\nThen post it in this conversation. See \`convoz app --help\`.\n\nGood looks like: one question per app, the answer or recommendation at the top, real data (no lorem ipsum), plain words, works on a phone, and one clear action for me if you need a decision.`;
}

const serverNow = () => Date.now() + usePlans.getState().skew;

/** WaitingSection lists what waits on the owner here: the agents' asks and agents that ask to join. Plan items show only in the header line, the plan rows of the chat and the row icon (conv 151). */
export function WaitingSection({ row, decide }: { row: Conversation; decide(iid: number, approve: boolean): void }) {
  const asks = (useNow((s) => s.now?.asks) ?? []).filter((a) => a.conversation_id === row.id);
  useEffect(() => void useNow.getState().load().catch(() => {}), [row.id]);
  const adds = row.pending ?? [];
  const count = asks.length + adds.length;
  if (count === 0) return null;
  return (
    <section aria-labelledby="det-wait" className="plansec">
      <h3 id="det-wait" className="sechead amber">
        <span className="pdot" data-tone="amber" aria-hidden="true" />
        {`Waiting on you · ${count}`}
      </h3>
      {asks.map((a) => (
        <div key={`a${a.id}`} className="pcard wait">
          <AskInline ask={a} labelId={`det-ask-${a.id}`} />
        </div>
      ))}
      {adds.map((add) => (
        <div key={`p${add.person.handle}`} className="pcard wait">
          <p className="pmeta">
            <Ava handle={add.person.handle} />
            <b>{who(add.person)}</b>
            {add.requested_by && add.requested_by.handle !== add.person.handle ? ` · asked by @${add.requested_by.handle}` : " · wants to join"}
          </p>
          <div className="pacts">
            <button type="button" className="chipbtn go" aria-label={`Approve @${add.person.handle}`} onClick={() => decide(add.person.id!, true)}>
              Approve
            </button>
            <button type="button" className="chipbtn" aria-label={`Decline @${add.person.handle}`} onClick={() => decide(add.person.id!, false)}>
              Decline
            </button>
          </div>
        </div>
      ))}
    </section>
  );
}

/** AgentsSection is the agents here, each a card with its plan. The owner is not an agent: it shows under "Conversation" as "You". */
export function AgentsSection({ row, board, act, onAdd, onRemove }: { row: Conversation; board: PlanBoard | undefined; act: PlanActions; onAdd(): void; onRemove(iid: number, handle: string): void }) {
  const agents = row.participants.filter((p) => p.kind === "agent");
  return (
    <section aria-labelledby="det-agents" className="plansec">
      <div className="sechead">
        <h3 id="det-agents">{`Agents · ${agents.length}`}</h3>
        <button type="button" className="quietbtn" onClick={onAdd}>
          + Add
        </button>
      </div>
      <ul aria-label="Agents" className="pcards">
        {agents.map((p) => (
          <AgentCard key={p.handle} person={p} plan={board?.plans.find((x) => x.handle === p.handle)} agent={board?.agents.find((x) => x.handle === p.handle)} conv={row.id} act={act} onRemove={onRemove} />
        ))}
      </ul>
      {agents.length === 0 ? (
        <div className="pcard pempty">
          <b>No agents here yet</b>
          <p>Add an agent to start work in this conversation.</p>
          <button type="button" className="chipbtn" onClick={onAdd}>
            Add agent
          </button>
        </div>
      ) : null}
    </section>
  );
}

interface CardState {
  word: string;
  tone: Tone;
  sub: string;
}

/** stateOf is an agent's chip and the line under its name: liveness first, then the plan. */
function stateOf(plan: Plan | undefined, agent: PlanAgent | undefined, now: number): CardState | null {
  const seen = agent?.last_seen_at;
  if (agent?.liveness === "logged_out") return { word: "Logged out", tone: "amber", sub: seen ? `last seen ${when(seen, now)}` : "never seen" };
  if (agent?.liveness === "not_responding") return { word: "Not responding", tone: "amber", sub: seen ? `last seen ${when(seen, now)}` : "never seen" };
  if (!plan) return null;
  const sub = `updated ${ago(plan.updated_at, now)}`;
  if (plan.blocked) return { word: "Blocked", tone: "red", sub };
  if (plan.doing && plan.eta && now >= plan.eta) return { word: "Late", tone: "amber", sub };
  if (plan.doing && !plan.eta && plan.due_at && now >= plan.due_at) return { word: "No update", tone: "amber", sub: "no update for 2 h" };
  if (plan.doing) return { word: "Working", tone: "green", sub };
  if (plan.waiting.length) return { word: "Waiting on you", tone: "amber", sub };
  return { word: "Done", tone: "grey", sub };
}

function AgentCard({ person, plan, agent, conv, act, onRemove }: { person: Person; plan: Plan | undefined; agent: PlanAgent | undefined; conv: number; act: PlanActions; onRemove(iid: number, handle: string): void }) {
  const now = serverNow();
  const st = stateOf(plan, agent, now);
  const h = person.handle;
  const seen = agent?.last_seen_at;
  const late = st?.word === "Late" || st?.word === "No update";
  return (
    <li id={planHash(h).slice(1)} className="pcard ag">
      <div className="aghead">
        <Ava handle={h} />
        <span className="pname">
          <span className="flex items-center gap-6">
            <b>{`@${h}`}</b>
            <TriageBadge handle={h} />
          </span>
          <span className="psub">
            {st ? (
              <span className="pstate" data-tone={st.tone}>
                <span className="pdot" data-tone={st.tone} aria-hidden="true" />
                {st.word}
              </span>
            ) : null}
            <span>{st ? st.sub : `No plan yet${seen ? ` · active ${ago(seen, now)}` : ""}`}</span>
          </span>
        </span>
        {person.id ? <AgentMenu handle={h} onRemove={() => onRemove(person.id!, h)} /> : null}
      </div>
      {agent?.liveness === "not_responding" ? (
        <p className="pnote">{`It has not picked up your message${agent.unanswered_since ? ` from ${when(agent.unanswered_since, now)}` : ""}. Its plan below may be out of date.`}</p>
      ) : null}
      {agent?.liveness === "logged_out" ? (
        <>
          <p className="pnote">Its machine is logged out. Log in again to bring it back.</p>
          <div className="pacts">
            <a className="chipbtn" href="/crew">
              Open Crew
            </a>
          </div>
        </>
      ) : null}
      {!plan ? (
        <div className="pacts">
          <button type="button" className="chipbtn" onClick={() => act.say(planRequest(h, conv, "share"))}>
            Ask for a plan
          </button>
        </div>
      ) : (
        <PlanBody plan={plan} now={now} />
      )}
      <div className="pacts">
        {plan ? (
          <Button type="button" className="chipbtn" onClick={() => act.say(planUpdateRequest(h, conv))}>
            Request plan update
          </Button>
        ) : null}
        <Button type="button" className="chipbtn" onClick={() => act.say(miniAppRequest(h))}>
          Request mini app
        </Button>
      </div>
      {late ? (
        <div className="pacts">
          <button type="button" className="chipbtn" onClick={() => act.say(planRequest(h, conv, "update"))}>
            Ask for an update
          </button>
        </div>
      ) : null}
    </li>
  );
}

/** AgentMenu is the "⋯" of a card: Remove lives here, so the header keeps to the name, the state and the age (owner msg 646). */
function AgentMenu({ handle, onRemove }: { handle: string; onRemove(): void }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: Event) => root.current && !root.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [open]);
  return (
    <span className="pmore" ref={root}>
      <button type="button" className="quietbtn" aria-label={`More for @${handle}`} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        ⋯
      </button>
      {open ? (
        <div className="msg-menu" role="menu">
          <button type="button" role="menuitem" onClick={() => (setOpen(false), onRemove())}>
            {`Remove @${handle}`}
          </button>
        </div>
      ) : null}
    </span>
  );
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
function NowBlock({ item, now }: { item: NonNullable<Plan["now"]>[number]; now: number }) {
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

function PlanBody({ plan, now }: { plan: Plan; now: number }) {
  const late = plan.now.some((n) => n.eta && now >= n.eta);
  return (
    <>
      {plan.now.length ? plan.now.map((n, i) => <NowBlock key={i} item={n} now={now} />) : (
        <div className="pnow">
          <p className="plbl">Now</p>
          <p className="pwhat quiet">Nothing planned</p>
        </div>
      )}
      {late && plan.nudged_at ? <p className="pnote">{`Convoz asked it for an update at ${when(plan.nudged_at, now)}.`}</p> : null}
      {plan.blocked ? <p className="pblk">{`Blocked: ${plan.blocked}`}</p> : null}
      {plan.next.length ? (
        <div className="pnextbox">
          <p className="plbl">Next</p>
          <ol className="pnext" aria-label="Next">
            {plan.next.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ol>
        </div>
      ) : null}
      {plan.done.length ? <DoneFold plan={plan} now={now} /> : null}
    </>
  );
}

/** DoneFold is the Done history, folded like "Older": a plain row, "Done · n", opens it, grouped by day with times. */
function DoneFold({ plan, now }: { plan: Plan; now: number }) {
  const [open, setOpen] = useState(false);
  let day = "";
  return (
    <div className="pfold">
      <button type="button" className="pfoldrow" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span>{`Done · ${plan.done.length}`}</span>
        <ChevronIcon />
      </button>
      {open ? (
        <ul className="pdone" aria-label="Done">
          {plan.done.flatMap((d, i) => {
            const label = dayLabel(d.at, now);
            const head =
              label !== day ? [<li key={`d${i}`} className="pday" role="presentation">{(day = label)}</li>] : [];
            return [
              ...head,
              <li key={i} className="pd">
                <span>{d.text}</span>
                <time>{clock(d.at)}</time>
              </li>,
            ];
          })}
        </ul>
      ) : null}
    </div>
  );
}

function who(p: Person): string {
  return p.kind === "agent" ? `@${p.handle}` : stripCf(p.display_name || p.handle);
}

function Ava({ handle }: { handle: string }) {
  return <span className={`ava p${paletteOf(handle)}`} aria-hidden="true" data-l={initials(handle)} />;
}
