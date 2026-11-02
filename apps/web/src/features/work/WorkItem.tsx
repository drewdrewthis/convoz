// One row of Work: one chat and one agent, two lines. It opens the chat with the details panel on that agent's plan card (#plan-<handle>).
import { AlertIcon, ClockIcon, HandIcon } from "@convoz/ui/icons";
import { ListRow } from "@convoz/ui/ListRow";
import { visit } from "../../shared/navigate.ts";
import { planHash } from "../conversations/index.ts";
import { ago, clock, when } from "../plan/index.ts";
import type { WorkRow } from "./look.ts";

const GLYPHS = { clock: ClockIcon, alert: AlertIcon, hand: HandIcon };
type GlyphKey = keyof typeof GLYPHS;

/** The shape and word of a row that needs a look; the colour never stands alone. */
function glyphOf(r: WorkRow): { glyph: GlyphKey; word: string; tone: string } | null {
  if (r.section === "needs") return { glyph: "hand", word: "Needs you", tone: "text-warning" };
  if (r.why === "late") return { glyph: "clock", word: "Late", tone: "text-danger" };
  if (r.section === "blocked") return { glyph: "alert", word: r.why === "blocked" ? "Blocked" : r.text, tone: "text-danger" };
  return null;
}

/** Glyph is a row's state as a shape with its word as the name; a row in work keeps the empty slot, so the titles line up. */
function Glyph({ r }: { r: WorkRow }) {
  const look = glyphOf(r);
  const Icon = look ? GLYPHS[look.glyph] : null;
  return (
    <span
      className={`inline-flex size-20 flex-none items-center justify-center ${look?.tone ?? ""} [&_svg]:size-15 [&_svg]:fill-none [&_svg]:stroke-current [&_svg]:[stroke-linecap:round] [&_svg]:[stroke-linejoin:round] [&_svg]:[stroke-width:2.2]`}
      {...(Icon && look ? { role: "img", "aria-label": look.word, title: look.word } : { "aria-hidden": true })}
    >
      {Icon ? <Icon /> : null}
    </span>
  );
}

/** dueChip is "Due Tue 18:00", "Due 12 Nov", or "Was due 18:00" once the date passed. */
function dueChip(due: number, now: number): string {
  const at = due - now < 7 * 86_400_000 ? when(due, now) : new Date(due).toLocaleDateString([], { day: "numeric", month: "short" });
  return now >= due ? `Was due ${at}` : `Due ${at}`;
}

/** The second line: the row's text, then for a plan in work its step and estimate, when it changed, and when Convoz asked for an update. */
function Second({ r, now }: { r: WorkRow; now: number }) {
  const first = r.plan?.now[0];
  const step = r.section === "doing" ? first?.step : undefined;
  const eta = r.section === "doing" ? first?.eta : undefined;
  const bits = [eta ? `ready ~${when(eta, now)}` : "", r.updated ? `updated ${ago(r.updated, now)}` : "", r.plan?.nudged_at ? `Convoz asked ${clock(r.plan.nudged_at)}` : ""].filter(Boolean);
  return (
    <span className="[display:block] overflow-hidden text-ellipsis whitespace-nowrap">
      <span className="text-text">{r.text}</span>
      {step ? (
        <span role="img" aria-label={`Step ${step.at} of ${step.of}`} className="tabular-nums">{` · ${step.at}/${step.of}`}</span>
      ) : null}
      {bits.length ? ` · ${bits.join(" · ")}` : null}
    </span>
  );
}

/** WorkItem is one row; a click opens the chat on this agent's plan card. */
export function WorkItem({ r, now }: { r: WorkRow; now: number }) {
  const href = `/chats/${r.conv}${planHash(r.handle)}`;
  return (
    <li className="list-none">
      <ListRow
        as="a"
        href={href}
        onClick={(e) => visit(e, href)}
        leading={<Glyph r={r} />}
        title={
          <span className="[display:block] overflow-hidden text-ellipsis whitespace-nowrap">
            <b className="font-semibold">{r.title}</b>
            <span className="text-13 text-muted">{` @${r.handle}`}</span>
          </span>
        }
        sub={<Second r={r} now={now} />}
        trailing={
          r.due ? (
            <span className={`flex-none rounded-full bg-soft px-8 py-2 text-12 tabular-nums ${now >= r.due ? "font-semibold text-danger" : "text-muted"}`}>{dueChip(r.due, now)}</span>
          ) : null
        }
      />
    </li>
  );
}
