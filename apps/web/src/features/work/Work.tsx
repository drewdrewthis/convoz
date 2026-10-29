import { Button } from "@convoz/ui/Button";
import { EmptyState } from "@convoz/ui/EmptyState";
import { DeliveryIcon } from "@convoz/ui/icons";
import { List, ListRow } from "@convoz/ui/ListRow";
import { useEffect, useId, useState } from "react";
import { humanError } from "../../shared/api.ts";
import { loadListOnMount, useData, useLive } from "../../shared/data.ts";
import { useNotice } from "../../shared/notice.tsx";
import { useDeliveries } from "../delivery/index.ts";
import { ALL, clock, usePlans } from "../plan/index.ts";
import { sections, type DoneItem, type Section } from "./look.ts";
import { WorkItem } from "./WorkItem.tsx";

/** loadAll reads what the page joins: every plan (with the open asks), the late deliverables, and the conversations (titles, members). */
const loadAll = () => Promise.all([useDeliveries.getState().load(), usePlans.getState().load(ALL), loadListOnMount()]);

/** A section shows this many rows, then "Show all N". */
const FIRST = 10;

/** Part is one section under its heading "<label> · N". */
function Part({ s, now }: { s: Section; now: number }) {
  const [all, setAll] = useState(false);
  const rows = all ? s.rows : s.rows.slice(0, FIRST);
  return (
    <section aria-label={s.label}>
      <h2 className="ghdr">{`${s.label} · ${s.rows.length}`}</h2>
      <List flush>
        {rows.map((r) => (
          <WorkItem key={r.key} r={r} now={now} />
        ))}
      </List>
      {s.rows.length > FIRST && !all ? (
        <Button variant="text" size="small" onClick={() => setAll(true)}>
          {`Show all ${s.rows.length}`}
        </Button>
      ) : null}
    </section>
  );
}

/** DoneToday is the closed chip "Done today · N" and, open, what the plans finished today. */
function DoneToday({ items }: { items: DoneItem[] }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  if (!items.length) return null;
  return (
    <section aria-label="Done today" className="mt-16">
      <Button variant="muted" size="chip" aria-expanded={open} aria-controls={id} onClick={() => setOpen((o) => !o)}>
        {`Done today · ${items.length}`}
      </Button>
      {open ? (
        <List as="div" flush id={id} className="mt-8">
          {items.map((d) => (
            <ListRow key={d.key} as="div" title={<span className="line-clamp-2 [overflow-wrap:anywhere]">{d.text}</span>} sub={`@${d.handle} · ${clock(d.at)} · ${d.title}`} />
          ))}
        </List>
      ) : null}
    </section>
  );
}

/** Work is /delivery: every plan in the highest section that applies, current from the stream with no button (owner, conv 179). */
export function Work() {
  const { fail } = useNotice();
  const data = useDeliveries((s) => s.data);
  const board = usePlans((s) => s.boards[ALL]);
  const skew = usePlans((s) => s.skew);
  const convs = useData((s) => s.conversations);
  const [showStale, setShowStale] = useState(false);
  useLive(() => void loadAll().catch(() => {}));
  useEffect(() => {
    loadAll().catch((err) => fail(humanError(err)));
  }, [fail]);
  if (!board || !convs) return <div id="work" aria-busy="true" />;
  const now = Date.now() + skew;
  const b = sections(board, data, convs, now, showStale);
  if (!b.sections.length && !b.done.length && !b.hidden) {
    return (
      <EmptyState id="work" variant="page" icon={<DeliveryIcon />}>
        Nothing in progress. When an agent sets a plan, it shows here.
      </EmptyState>
    );
  }
  return (
    <div id="work">
      <p className="m-0 px-4 pt-8 pb-4 text-13 text-muted">Live · Convoz asks agents when a plan is late</p>
      {b.sections.map((s) => (
        <Part key={s.key} s={s} now={now} />
      ))}
      {b.hidden ? (
        <p className="m-0 flex items-center gap-8 px-4 pt-12 text-13 text-muted">
          {`${b.hidden} stale ${b.hidden === 1 ? "chat" : "chats"} hidden ·`}
          <Button variant="text" size="inline" onClick={() => setShowStale(true)}>
            Show
          </Button>
        </p>
      ) : null}
      <DoneToday items={b.done} />
    </div>
  );
}
