import type { Delivery, ShippedDelivery } from "@convoz/api-client";
import { Button } from "@convoz/ui/Button";
import { EmptyState } from "@convoz/ui/EmptyState";
import { AlertIcon, ClockIcon, DeliveryIcon, HandIcon, TickIcon } from "@convoz/ui/icons";
import { List, ListRow } from "@convoz/ui/ListRow";
import { useEffect, useId, useState } from "react";
import { humanError } from "../../shared/api.ts";
import { useLive } from "../../shared/data.ts";
import { visit } from "../../shared/navigate.ts";
import { useNotice } from "../../shared/notice.tsx";
import { clock } from "../plan/index.ts";
import { daily, dailyLine, dueText, grouped, STATE, subText } from "./look.ts";
import { useDeliveries } from "./store.ts";

const GLYPHS = { clock: ClockIcon, alert: AlertIcon, hand: HandIcon };
const TONES = { red: "text-danger", amber: "text-warning", green: "text-success", grey: "text-muted" };

/** Glyph is a row's state as a shape with its word as the name; an on-track row keeps the empty slot, so the titles line up. */
function Glyph({ d }: { d: Delivery }) {
  const look = STATE[d.state];
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

/** Row is one deliverable: the whole row opens its conversation, with no buttons on it. */
function Row({ d, now }: { d: Delivery; now: number }) {
  const href = `/chats/${d.conversation_id}`;
  return (
    <ListRow
      as="a"
      href={href}
      onClick={(e) => visit(e, href)}
      chevron
      leading={<Glyph d={d} />}
      title={<span className="line-clamp-2 [overflow-wrap:anywhere]">{d.text}</span>}
      sub={<span className="[display:block] overflow-hidden text-ellipsis whitespace-nowrap">{subText(d, now)}</span>}
      trailing={<span className={`max-w-[25%] flex-none text-right text-13 tabular-nums ${d.state === "late" ? "font-semibold text-danger" : "text-muted"}`}>{dueText(d, now)}</span>}
    />
  );
}

/** Shipped is the closed chip "Shipped today · N" and, open, what shipped today. */
function Shipped({ items }: { items: ShippedDelivery[] }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  if (!items.length) return null;
  return (
    <section aria-label="Shipped today" className="mt-16">
      <Button variant="muted" size="chip" aria-expanded={open} aria-controls={id} onClick={() => setOpen((o) => !o)}>
        {`Shipped today · ${items.length}`}
      </Button>
      {open ? (
        <List as="div" flush id={id} className="mt-8">
          {items.map((s) => (
            <ListRow key={`${s.conversation_id}-${s.handle}-${s.text}`} as="div" title={<span className="line-clamp-2 [overflow-wrap:anywhere]">{s.text}</span>} sub={`@${s.handle} · shipped ${clock(s.at)} · ${s.title}`} />
          ))}
        </List>
      ) : null}
    </section>
  );
}

/** Deliveries is /delivery: every deliverable of every agent, what the owner must act on first, then by day (owner, conv 179 msg 9734). */
export function Deliveries() {
  const { fail } = useNotice();
  const data = useDeliveries((s) => s.data);
  const skew = useDeliveries((s) => s.skew);
  useLive(() => void useDeliveries.getState().load().catch(() => {}));
  useEffect(() => {
    useDeliveries.getState().load().catch((err) => fail(humanError(err)));
  }, [fail]);
  if (!data) return <div id="deliveries" aria-busy="true" />;
  const now = Date.now() + skew;
  const day = daily(data, now);
  const shippedToday = data.shipped.filter((s) => new Date(s.at).toDateString() === new Date(now).toDateString());
  if (!data.deliveries.length && !shippedToday.length) {
    return (
      <EmptyState id="deliveries" variant="page" icon={<DeliveryIcon />}>
        No deliveries yet. When an agent commits to a date, it shows here.
      </EmptyState>
    );
  }
  return (
    <div id="deliveries">
      <p id="daily" className="m-0 flex items-center gap-10 px-4 pt-8 pb-4 text-14 font-semibold">
        {day.late ? null : (
          <span aria-hidden="true" className="flex size-28 flex-none items-center justify-center rounded-full bg-soft text-accent-text [&_svg]:size-14 [&_svg]:fill-none [&_svg]:stroke-current [&_svg]:[stroke-width:2.4]">
            <TickIcon />
          </span>
        )}
        <span>{dailyLine(day)}</span>
      </p>
      {grouped(data.deliveries, now).map((g) => (
        <section key={g.key} aria-label={g.label}>
          <h2 className="ghdr">{`${g.label} · ${g.rows.length}`}</h2>
          <List as="div" flush>
            {g.rows.map((d) => (
              <Row key={`${d.conversation_id}-${d.identity_id}-${d.text}`} d={d} now={now} />
            ))}
          </List>
        </section>
      ))}
      <Shipped items={shippedToday} />
    </div>
  );
}
