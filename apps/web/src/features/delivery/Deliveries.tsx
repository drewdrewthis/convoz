import type { ShippedDelivery } from "@convoz/api-client";
import { Button } from "@convoz/ui/Button";
import { EmptyState } from "@convoz/ui/EmptyState";
import { DeliveryIcon, TickIcon } from "@convoz/ui/icons";
import { List, ListRow } from "@convoz/ui/ListRow";
import { useEffect, useId, useState } from "react";
import { humanError } from "../../shared/api.ts";
import { loadListOnMount, useData, useLive } from "../../shared/data.ts";
import { useNotice } from "../../shared/notice.tsx";
import { ALL, clock, usePlans } from "../plan/index.ts";
import { daily, dailyLine, grouped, rowsOf, type PlanRow } from "./look.ts";
import { PlanItem } from "./PlanItem.tsx";
import { useDeliveries } from "./store.ts";

/** loadAll reads what the page joins: the deliverables (the daily line, Shipped), every plan, and the conversations (titles, members). */
const loadAll = () => Promise.all([useDeliveries.getState().load(), usePlans.getState().load(ALL), loadListOnMount()]);

/** A No date group longer than this folds behind its chip. */
const FOLD_OVER = 10;

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

/** Group is one group of plans under its heading "<label> · N"; a long No date group folds behind a chip. */
function Group({ k, label, rows, now }: { k: string; label: string; rows: PlanRow[]; now: number }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const folded = k === "none" && rows.length > FOLD_OVER;
  const list = (
    <List flush id={id}>
      {rows.map((r) => (
        <PlanItem key={r.key} r={r} now={now} />
      ))}
    </List>
  );
  return (
    <section aria-label={label}>
      {folded ? null : <h2 className="ghdr">{`${label} · ${rows.length}`}</h2>}
      {folded ? (
        <Button variant="muted" size="chip" aria-expanded={open} aria-controls={id} onClick={() => setOpen((o) => !o)}>
          {`${label} · ${rows.length}`}
        </Button>
      ) : null}
      {!folded || open ? list : null}
    </section>
  );
}

/** Deliveries is /delivery: every agent's current plan, what the owner must act on first, then by delivery date (owner, conv 179 msgs 9734, 9982). */
export function Deliveries() {
  const { fail } = useNotice();
  const data = useDeliveries((s) => s.data);
  const board = usePlans((s) => s.boards[ALL]);
  const skew = usePlans((s) => s.skew);
  const convs = useData((s) => s.conversations);
  useLive(() => void loadAll().catch(() => {}));
  useEffect(() => {
    loadAll().catch((err) => fail(humanError(err)));
  }, [fail]);
  if (!data || !board || !convs) return <div id="deliveries" aria-busy="true" />;
  const now = Date.now() + skew;
  const day = daily(data, now);
  const rows = rowsOf(board, convs, now);
  const shippedToday = data.shipped.filter((s) => new Date(s.at).toDateString() === new Date(now).toDateString());
  if (!rows.length && !shippedToday.length) {
    return (
      <EmptyState id="deliveries" variant="page" icon={<DeliveryIcon />}>
        No plans yet. When an agent sets a plan in a chat, it shows here.
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
      {grouped(rows).map((g) => (
        <Group key={g.key} k={g.key} label={g.label} rows={g.rows} now={now} />
      ))}
      <Shipped items={shippedToday} />
    </div>
  );
}
