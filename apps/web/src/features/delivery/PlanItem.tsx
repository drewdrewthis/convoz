// One plan of the Deliveries page: a row that opens in place to the plan and its two actions, "Request update" and "Open chat".
import { Button } from "@convoz/ui/Button";
import { AlertIcon, ClockIcon, HandIcon, TickIcon } from "@convoz/ui/icons";
import { ListRow } from "@convoz/ui/ListRow";
import { useEffect, useId, useState } from "react";
import { humanError } from "../../shared/api.ts";
import { visit } from "../../shared/navigate.ts";
import { useNotice } from "../../shared/notice.tsx";
import { NowBlock } from "../conversations/index.ts";
import { clock, when } from "../plan/index.ts";
import { dueText, STATE, subText, titleOf, type PlanRow } from "./look.ts";
import { HOLD, requestUpdate, serverNow, useRequests } from "./requests.ts";

const GLYPHS = { clock: ClockIcon, alert: AlertIcon, hand: HandIcon };
const TONES = { red: "text-danger", amber: "text-warning", green: "text-success", grey: "text-muted" };
/** On a phone the actions fill the width, one above the other. */
const ACTION = "max-[600px]:w-full";

/** Glyph is a row's state as a shape with its word as the name; an on-track row keeps the empty slot, so the titles line up. */
function Glyph({ r }: { r: PlanRow }) {
  const look = STATE[r.state];
  const Icon = look.glyph ? GLYPHS[look.glyph] : null;
  return (
    <span
      className={`inline-flex size-20 flex-none items-center justify-center ${TONES[look.tone]} [&_svg]:size-15 [&_svg]:fill-none [&_svg]:stroke-current [&_svg]:[stroke-linecap:round] [&_svg]:[stroke-linejoin:round] [&_svg]:[stroke-width:2.2]`}
      {...(Icon ? { role: "img", "aria-label": look.word, title: look.word } : { "aria-hidden": true })}
      data-tone={look.tone}
    >
      {Icon ? <Icon /> : null}
    </span>
  );
}

/** PlanItem is one plan; a late or blocked one starts open, so what needs the owner shows without a tap. */
export function PlanItem({ r, now }: { r: PlanRow; now: number }) {
  const [open, setOpen] = useState(r.state === "late" || r.state === "blocked");
  const id = useId();
  return (
    <li className="list-none">
      <ListRow
        as="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((o) => !o)}
        leading={<Glyph r={r} />}
        title={<span className="line-clamp-2 [overflow-wrap:anywhere]">{titleOf(r.plan)}</span>}
        sub={<span className="[display:block] overflow-hidden text-ellipsis whitespace-nowrap">{subText(r)}</span>}
        trailing={<span className={`max-w-[25%] flex-none text-right text-13 tabular-nums ${r.state === "late" ? "font-semibold text-danger" : "text-muted"}`}>{dueText(r, now)}</span>}
      />
      {open ? <PlanOpen id={id} r={r} now={now} /> : null}
    </li>
  );
}

/** PlanOpen is the plan itself (as the details panel draws it) and the actions. */
function PlanOpen({ id, r, now }: { id: string; r: PlanRow; now: number }) {
  const p = r.plan;
  const href = `/chats/${p.conversation_id}`;
  return (
    <div id={id} className="px-16 pb-16">
      {p.now.map((n, i) => (
        <NowBlock key={i} item={n} now={now} />
      ))}
      {p.blocked ? <p className="pblk">{`Blocked: ${p.blocked}`}</p> : null}
      {p.waiting.map((w) => (
        <p key={w.text} className="pwhen amber">{`Waiting on you: ${w.text}`}</p>
      ))}
      {p.next.length ? (
        <div className="pnextbox">
          <p className="plbl">Next</p>
          <ol className="pnext" aria-label="Next">
            {p.next.slice(0, 3).map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ol>
          {p.next.length > 3 ? <p className="pnote">{`+${p.next.length - 3} more`}</p> : null}
        </div>
      ) : null}
      {p.deliver?.length ? (
        <div>
          <p className="plbl">Deliver</p>
          {p.deliver.map((d) => (
            <p key={d.text} className={`pwhen ${now >= d.due ? "amber" : ""}`}>
              <span className="text-text">{d.text}</span>
              {now >= d.due ? ` · was due ${when(d.due, now)}` : ` · due ${when(d.due, now)}`}
            </p>
          ))}
        </div>
      ) : null}
      {r.agent?.liveness === "not_responding" ? <p className="pnote">{notPicked(r, now)}</p> : null}
      <div className="mt-12 flex flex-wrap gap-8 max-[600px]:flex-col">
        {r.agent?.liveness === "logged_out" ? (
          <Button size="small" className={ACTION} href="/crew" onClick={(e) => visit(e, "/crew")}>
            Open Crew
          </Button>
        ) : (
          <RequestButton r={r} />
        )}
        <Button variant="text" size="small" className={ACTION} href={href} onClick={(e) => visit(e, href)}>
          Open chat
        </Button>
      </div>
      <RequestNote r={r} />
    </div>
  );
}

function notPicked(r: PlanRow, now: number): string {
  const since = r.agent?.unanswered_since ?? r.agent?.last_seen_at;
  return since ? `It has not picked up messages since ${when(since, now)}.` : "It has not picked up messages.";
}

/** RequestButton asks the agent for an update; after a request it rests for HOLD, unless the plan moved since. */
function RequestButton({ r }: { r: PlanRow }) {
  const { fail } = useNotice();
  const at = useRequests((s) => s.asked[r.key]);
  const [sending, setSending] = useState(false);
  const [, wake] = useState(0);
  const now = serverNow();
  const resting = at !== undefined && r.plan.updated_at <= at && now < at + HOLD;
  useEffect(() => {
    if (!resting) return;
    const t = setTimeout(() => wake((n) => n + 1), at + HOLD - now + 50);
    return () => clearTimeout(t);
  }, [resting, at, now]);
  const press = () => {
    setSending(true);
    requestUpdate(r.key, r.plan.handle, r.plan.conversation_id)
      .catch((err) => fail(humanError(err)))
      .finally(() => setSending(false));
  };
  if (sending) {
    return (
      <Button size="small" className={ACTION} disabled aria-busy="true">
        Sending…
      </Button>
    );
  }
  if (resting) {
    return (
      <Button size="small" className={`${ACTION} [&_svg]:size-14 [&_svg]:fill-none [&_svg]:stroke-current [&_svg]:[stroke-width:2.4]`} disabled>
        Requested
        <span aria-hidden="true" className="inline-flex">
          <TickIcon />
        </span>
      </Button>
    );
  }
  return (
    <Button size="small" className={ACTION} onClick={press}>
      Request update
    </Button>
  );
}

/** RequestNote says what came of the last request: no update yet, or when the plan moved since. */
function RequestNote({ r }: { r: PlanRow }) {
  const at = useRequests((s) => s.asked[r.key]);
  if (at === undefined) return null;
  const text = r.plan.updated_at > at ? `Updated ${clock(r.plan.updated_at)}` : `Requested ${clock(at)} · no update yet`;
  return <p className="pnote">{text}</p>;
}
