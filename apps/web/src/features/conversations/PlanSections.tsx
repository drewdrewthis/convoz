// The plan parts of the details panel (the UX pass approved for phase 1): "Waiting on you" with the action in place, then one card per
// agent (its state, Now with the estimate, Next numbered, Done folded). The "Conversation" settings follow in Details.tsx.
import type { Conversation, Person, Plan, PlanAgent, PlanBoard } from "@convoz/api-client";
import { useEffect, useState } from "react";
import { initials, paletteOf, stripCf } from "../../shared/chat.ts";
import { AskInline, useNow } from "../now/index.ts";
import { ago, clock, dayLabel, span, usePlans, when, type Tone } from "../plan/index.ts";

/** What the panel's plan parts can do in the conversation: post a message as the owner, or start one in the composer. */
export interface PlanActions {
  say(text: string): void;
  reply(text: string): void;
}

const URL_RE = /https?:\/\/[^\s<>"]+/;
const serverNow = () => Date.now() + usePlans.getState().skew;

/** WaitingSection lists what waits on the owner here: the agents' asks, the items their plans wait on, and agents that ask to join. */
export function WaitingSection({ row, board, act, decide }: { row: Conversation; board: PlanBoard | undefined; act: PlanActions; decide(iid: number, approve: boolean): void }) {
  const asks = (useNow((s) => s.now?.asks) ?? []).filter((a) => a.conversation_id === row.id);
  const [said, setSaid] = useState<Record<string, number>>({});
  useEffect(() => void useNow.getState().load().catch(() => {}), [row.id]);
  const items = (board?.plans ?? []).flatMap((p) => p.waiting.map((w) => ({ handle: p.handle, ...w })));
  const adds = row.pending ?? [];
  const count = asks.length + items.length + adds.length;
  if (count === 0) return null;
  const now = serverNow();
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
      {items.map((it) => {
        const key = `${it.handle}|${it.text}`;
        const link = URL_RE.exec(it.text)?.[0];
        return (
          <div key={key} className={`pcard wait${said[key] ? " sent" : ""}`}>
            <p className="pmeta">
              <Ava handle={it.handle} />
              <b>{`@${it.handle}`}</b>
              {` · waiting ${span(now - it.since)}`}
            </p>
            <p className="pq">{it.text}</p>
            {said[key] ? (
              <p className="psent">{`You said it is done · ${clock(said[key])}. It goes when @${it.handle} updates its plan.`}</p>
            ) : (
              <div className="pacts">
                <button
                  type="button"
                  className="chipbtn go"
                  onClick={() => {
                    act.say(`@${it.handle} I did it: ${it.text}`);
                    setSaid((s) => ({ ...s, [key]: Date.now() }));
                  }}
                >
                  I did it
                </button>
                <button type="button" className="chipbtn" onClick={() => act.reply(`@${it.handle} about "${it.text}": `)}>
                  Reply
                </button>
                {link ? (
                  <a className="chipbtn" href={link} target="_blank" rel="noopener noreferrer">
                    Open
                  </a>
                ) : null}
              </div>
            )}
          </div>
        );
      })}
      {adds.map((add) => (
        <div key={`p${add.person.handle}`} className="pcard wait">
          <p className="pmeta">
            <Ava handle={add.person.handle} />
            <b>{who(add.person)}</b>
            {add.requested_by ? ` · asked by @${add.requested_by.handle}` : " · wants to join"}
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
          <AgentCard key={p.handle} person={p} plan={board?.plans.find((x) => x.handle === p.handle)} agent={board?.agents.find((x) => x.handle === p.handle)} act={act} onRemove={onRemove} />
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

function AgentCard({ person, plan, agent, act, onRemove }: { person: Person; plan: Plan | undefined; agent: PlanAgent | undefined; act: PlanActions; onRemove(iid: number, handle: string): void }) {
  const now = serverNow();
  const st = stateOf(plan, agent, now);
  const h = person.handle;
  const seen = agent?.last_seen_at;
  const late = st?.word === "Late" || st?.word === "No update";
  return (
    <li className="pcard ag">
      <div className="aghead">
        <Ava handle={h} />
        <span className="pname">
          <b>{`@${h}`}</b>
          <span>{st ? st.sub : `No plan yet${seen ? ` · active ${ago(seen, now)}` : ""}`}</span>
        </span>
        {st ? (
          <span className="pstate" data-tone={st.tone}>
            <span className="pdot" data-tone={st.tone} aria-hidden="true" />
            {st.word}
          </span>
        ) : null}
        {person.id ? (
          <button type="button" className="quietbtn" aria-label={`Remove @${h}`} onClick={() => onRemove(person.id!, h)}>
            Remove
          </button>
        ) : null}
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
          <button type="button" className="chipbtn" onClick={() => act.say(`@${h}, please share your plan for this conversation.`)}>
            Ask for a plan
          </button>
        </div>
      ) : (
        <PlanBody plan={plan} now={now} />
      )}
      {late ? (
        <div className="pacts">
          <button type="button" className="chipbtn" onClick={() => act.say(`@${h}, please update your plan for this conversation.`)}>
            Ask for an update
          </button>
        </div>
      ) : null}
    </li>
  );
}

function PlanBody({ plan, now }: { plan: Plan; now: number }) {
  const late = Boolean(plan.doing && plan.eta && now >= plan.eta);
  const timing = [plan.step ? `Step ${plan.step.at} of ${plan.step.of}` : ""];
  if (plan.eta && !late) timing.push(`ready ~${when(plan.eta, now)} · in ${span(plan.eta - now)}`);
  if (!plan.eta && plan.doing_since) timing.push(`Started ${when(plan.doing_since, now)} · no estimate`);
  return (
    <>
      <div className="pnow">
        <p className="plbl">Now</p>
        {plan.doing ? (
          <>
            <p className="pwhat">{plan.doing}</p>
            {late ? (
              <p className="pwhen amber">{`Was due ${when(plan.eta!, now)} · ${span(now - plan.eta!)} late`}</p>
            ) : timing.some(Boolean) ? (
              <p className="pwhen">{timing.filter(Boolean).join(" · ")}</p>
            ) : null}
            {late && plan.nudged_at ? <p className="pnote">{`Convoz asked it for an update at ${when(plan.nudged_at, now)}.`}</p> : null}
          </>
        ) : (
          <p className="pwhat quiet">Nothing planned</p>
        )}
        {plan.blocked ? <p className="pblk">{`Blocked: ${plan.blocked}`}</p> : null}
      </div>
      {plan.next.length ? (
        <>
          <p className="plbl">Next</p>
          <ol className="pnext" aria-label="Next">
            {plan.next.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ol>
        </>
      ) : null}
      {plan.done.length ? <DoneFold plan={plan} now={now} /> : null}
    </>
  );
}

/** DoneFold is the Done history, folded like "Older": "Done · n" opens it, grouped by day with times. */
function DoneFold({ plan, now }: { plan: Plan; now: number }) {
  const [open, setOpen] = useState(false);
  let day = "";
  return (
    <div className="pfold">
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
      <button type="button" className="foldbtn" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {open ? "Show less" : `Done · ${plan.done.length}`}
      </button>
    </div>
  );
}

function who(p: Person): string {
  return p.kind === "agent" ? `@${p.handle}` : stripCf(p.display_name || p.handle);
}

function Ava({ handle }: { handle: string }) {
  return <span className={`ava p${paletteOf(handle)}`} aria-hidden="true" data-l={initials(handle)} />;
}
