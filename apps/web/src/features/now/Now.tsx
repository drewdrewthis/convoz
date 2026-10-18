import type { Ask, Me, NowPendingAdd } from "@convoz/api-client";
import { AskCard, whoLine, stateLine, type Answer } from "@convoz/app-kit";
import { Wordmark } from "@convoz/ui/Wordmark";
import { TickIcon } from "@convoz/ui/icons";
import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { call, client, humanError } from "../../shared/api.ts";
import { useNotice } from "../../shared/notice.tsx";
import { markUseful } from "../../shared/perf.ts";
import { data } from "../../shared/data.ts";
import { answerAsk, dismissAsk, snoozeAsk, unsnoozeAsk, useNow } from "./store.ts";
import { agentRequests, RequestCard } from "./requests.tsx";
import { presetsAt } from "./presets.ts";

/** Now is /: what needs the owner. Open asks first (urgent, then the newest), then the adds agents wait on and the machines waiting
 *  to connect; Snoozed and Answered today fold away below. With nothing waiting, "All clear". */
export function Now() {
  const { say, fail } = useNotice();
  const load = useNow((s) => s.load);
  const now = useNow((s) => s.now);
  const skew = useNow((s) => s.skew);
  const [me, setMe] = useState<Me | null>(null);
  const [onePasskey, setOnePasskey] = useState(false);
  const [busy, setBusy] = useState<ReadonlySet<number>>(new Set());
  const [folds, setFolds] = useState({ snoozed: false, answered: false });
  const focusAfter = useRef<number | null>(null);
  const deepLinked = useRef(false);

  useEffect(() => {
    (async () => {
      setMe(await data.loadMe());
      // The passkey count only shapes a hint: with no link it is left out, and Now still shows what the device kept.
      const passkeys = await call(client.GET("/api/me/passkeys")).then((r) => r.passkeys, () => null);
      if (passkeys) setOnePasskey(passkeys.length === 1);
      await load();
    })().catch((err) => fail(humanError(err)));
  }, [load, fail]);

  useEffect(() => {
    if (now) markUseful();
  }, [now]);

  const pending = now?.machine_requests ?? null;
  const plain = (pending ?? []).filter((m) => !m.identity);
  const connecting = agentRequests(now);
  const waiting = plain.length + connecting.length;
  const asks = now?.asks ?? [];
  const adds = now?.pending_adds ?? [];
  const snoozed = now?.snoozed ?? [];
  const answered = now?.answered_today ?? [];
  const some = Boolean(pending && (waiting || asks.length || adds.length));

  // After a card leaves the list the next one takes the focus, so the keys go on working.
  useEffect(() => {
    if (focusAfter.current === null) return;
    document.querySelector<HTMLElement>(`[data-ask="${focusAfter.current}"]`)?.focus();
    focusAfter.current = null;
  }, [now]);

  const reload = useCallback(() => load().then(() => undefined), [load]);

  /** act runs one change of an ask once at a time. Where the card goes away, focus moves to its neighbour. */
  const act = async (ask: Ask, leaves: boolean, run: () => Promise<{ ask: Ask; lost: boolean }>, label?: string) => {
    if (busy.has(ask.id)) return;
    setBusy((b) => new Set(b).add(ask.id));
    if (leaves) {
      const at = asks.findIndex((a) => a.id === ask.id);
      focusAfter.current = (asks[at + 1] ?? asks[at - 1])?.id ?? null;
    }
    try {
      const r = await run();
      if (r.ask.state === "answered") setFolds((f) => ({ ...f, answered: true }));
      if (r.lost && label) say(lostNote(r.ask, label));
      await reload();
    } catch (err) {
      fail(humanError(err));
    } finally {
      setBusy((b) => {
        const next = new Set(b);
        next.delete(ask.id);
        return next;
      });
    }
  };

  const answer = (ask: Ask, a: Answer) =>
    act(ask, true, () => answerAsk(ask.id, { ...a, if_version: ask.version, via: "now" }), a.choice === "custom" ? (a.text ?? "") : (ask.options[a.choice === "alternative" ? (a.index ?? 1) : 0]?.label ?? ""));

  const moveFocus = (e: KeyboardEvent<HTMLElement>) => {
    const step = e.key === "j" ? 1 : e.key === "k" ? -1 : 0;
    const t = e.target as HTMLElement;
    if (!step || e.metaKey || e.ctrlKey || e.altKey || t.tagName === "INPUT" || t.tagName === "TEXTAREA") return;
    const cards = [...e.currentTarget.querySelectorAll<HTMLElement>("[data-ask]")];
    const here = cards.findIndex((c) => c.contains(t));
    cards[Math.min(cards.length - 1, Math.max(0, here + step))]?.focus();
    e.preventDefault();
  };

  const denyAll = async () => {
    try {
      await call(client.POST("/api/machines/requests/deny-all", { body: {} }));
      await reload();
    } catch (err) {
      fail(humanError(err));
    }
  };

  // /now/machine/:id (the link in the push) brings that request's card into view.
  useEffect(() => {
    const id = /^\/now\/machine\/(\d+)$/.exec(location.pathname)?.[1];
    if (id && pending?.some((r) => r.id === Number(id)) && !deepLinked.current) {
      deepLinked.current = true;
      document.querySelector<HTMLElement>(`[data-request="/api/machines/requests/${id}"]`)?.scrollIntoView({ block: "center" });
    }
  }, [pending]);

  const presets = presetsAt(Date.now() + skew);

  return (
    <>
      <div id="notes">
        {me?.recovery?.hold_until ? (
          <p className="banner" role="status">{`You signed in with a recovery code. Codes left: ${me.recovery.codes_left}. Some actions are paused for 24 hours.`}</p>
        ) : null}
        {onePasskey ? (
          <div className="card note">
            <span>One passkey guards this account.</span>
            <a href="/settings/passkeys">Add a second way in</a>
          </div>
        ) : null}
      </div>
      <div id="allclear" hidden={!now || some}>
        <div className="allclear">
          <span className="tick" aria-hidden="true">
            <TickIcon />
          </span>
          <span>All clear. Nothing needs you.</span>
        </div>
        <div className="wordmark">
          <Wordmark />
        </div>
      </div>
      <Folds
        snoozed={snoozed}
        answered={answered}
        open={folds}
        toggle={(k) => setFolds((f) => ({ ...f, [k]: !f[k] }))}
        unsnooze={(ask) => void act(ask, false, () => unsnoozeAsk(ask.id))}
      />
      {asks.length ? (
        <section id="asks" className="asks" onKeyDown={moveFocus}>
          {asks.map((ask) => (
            <NowAsk key={ask.id} ask={ask} busy={busy.has(ask.id)} presets={presets} act={act} answer={answer} />
          ))}
        </section>
      ) : null}
      {adds.length ? (
        <section id="adds" className="block" aria-label="Adds to decide">
          {adds.map((add) => (
            <PendingAdd key={`${add.conversation.id}-${add.person.id}`} add={add} reload={reload} />
          ))}
        </section>
      ) : null}
      <section id="requests-block" className="block" aria-labelledby="requests-heading" hidden={!waiting}>
        <div className="block-head">
          <h2 id="requests-heading">Machine requests</h2>
          <button id="deny-all" className="btn small" type="button" hidden={!waiting} onClick={denyAll}>
            Deny all
          </button>
        </div>
        <div id="requests">
          {(pending ?? []).map((req) =>
            req.identity ? <RequestCard key={`m${req.id}`} item={{ kind: "login", key: `m${req.id}`, machine: req }} changed={reload} /> : <RequestCard key={`m${req.id}`} item={{ kind: "plain", key: `m${req.id}`, machine: req }} changed={reload} />,
          )}
          {connecting.filter((c) => c.kind === "session").map((c) => (
            <RequestCard key={c.key} item={c} changed={reload} />
          ))}
        </div>
      </section>
    </>
  );
}

/** lostNote tells a person whose answer lost the race what the ask says now. */
function lostNote(won: Ask, tried: string): string {
  const how = won.state === "answered" ? `Already ${won.chosen?.kind === "custom" ? "replied" : "answered"}: ${won.answer ?? ""}.` : `The ask is ${won.state} now.`;
  return `${how} Your answer "${tried}" was not used.`;
}

/** untilText is a snooze end as the owner reads it: the time today, else the weekday and the time. */
function untilText(at: number): string {
  const d = new Date(at);
  const today = new Date().toDateString() === d.toDateString();
  return d.toLocaleString([], today ? { hour: "numeric", minute: "2-digit" } : { weekday: "short", hour: "numeric", minute: "2-digit" });
}

function NowAsk({ ask, busy, presets, act, answer }: { ask: Ask; busy: boolean; presets: { key: string; label: string }[]; act: ActFn; answer: (ask: Ask, a: Answer) => void }) {
  const id = useId();
  return (
    <AskCard
      ask={ask}
      where="now"
      labelId={id}
      presets={presets}
      busy={busy}
      dataId={ask.id}
      openHref={`/chats/${ask.conversation_id}`}
      onAnswer={(a) => answer(ask, a)}
      onDismiss={() => void act(ask, true, () => dismissAsk(ask.id, ask.version))}
      onUndismiss={() => undefined}
      onSnooze={(preset) => void act(ask, true, () => snoozeAsk(ask.id, preset))}
    />
  );
}

type ActFn = (ask: Ask, leaves: boolean, run: () => Promise<{ ask: Ask; lost: boolean }>, label?: string) => Promise<void>;

/** Folds are the chips under the top bar ("Snoozed · 1", "Answered today · 3") and, when one is open, its rows. A chip is not there when it has no rows. */
function Folds({ snoozed, answered, open, toggle, unsnooze }: { snoozed: Ask[]; answered: Ask[]; open: { snoozed: boolean; answered: boolean }; toggle: (k: "snoozed" | "answered") => void; unsnooze: (ask: Ask) => void }) {
  const id = useId();
  if (!snoozed.length && !answered.length) return null;
  const chip = (key: "snoozed" | "answered", name: string, rows: Ask[]) =>
    rows.length ? (
      <button className="foldbtn" type="button" onMouseDown={(e) => e.preventDefault()} aria-expanded={open[key]} aria-controls={`${id}-${key}`} onClick={() => toggle(key)}>
        <span>{name}</span>
        <span aria-hidden="true">·</span>
        <span>{rows.length}</span>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>
    ) : null;
  const rowsOf = (key: "snoozed" | "answered", rows: Ask[], tail: (ask: Ask) => React.ReactNode) =>
    open[key] && rows.length ? (
      <ul id={`${id}-${key}`} className="foldrows">
        {rows.map((ask) => (
          <li key={ask.id}>
            <span className="foldq">{ask.question}</span>
            <span className="foldwho">{`${whoLine(ask.asker)} · ${ask.conversation?.title || "Untitled conversation"}`}</span>
            {tail(ask)}
          </li>
        ))}
      </ul>
    ) : null;
  return (
    <div className="folds">
      <div className="foldchips">
        {chip("snoozed", "Snoozed", snoozed)}
        {chip("answered", "Answered today", answered)}
      </div>
      {rowsOf("snoozed", snoozed, (ask) => (
        <>
          <span className="foldstate">{`Snoozed until ${untilText(ask.snoozed_until ?? 0)}`}</span>
          <button className="askbtn" type="button" onClick={() => unsnooze(ask)}>
            Unsnooze
          </button>
        </>
      ))}
      {rowsOf("answered", answered, (ask) => (
        <span className="foldstate">{stateLine(ask)}</span>
      ))}
    </div>
  );
}

/** PendingAdd is an agent asking to bring another one into a conversation; the owner decides here or in the conversation. */
function PendingAdd({ add, reload }: { add: NowPendingAdd; reload: () => Promise<void> }) {
  const { fail } = useNotice();
  const id = useId();
  const [working, setWorking] = useState(false);
  const who = add.requested_by ? whoLine(add.requested_by) : "An agent";
  const decide = async (approve: boolean) => {
    setWorking(true);
    try {
      const path = approve ? "/api/conversations/{id}/participants/{iid}/approve" : "/api/conversations/{id}/participants/{iid}/decline";
      await call(client.POST(path, { params: { path: { id: add.conversation.id, iid: add.person.id! } }, body: {} }));
      await reload();
    } catch (err) {
      fail(humanError(err));
      setWorking(false);
    }
  };
  return (
    <article className="card" aria-labelledby={id}>
      <h3 id={id}>{`${who} wants to add ${whoLine(add.person)}`}</h3>
      <p className="sub">{add.conversation.title || "Untitled conversation"}</p>
      <div className="btns">
        <button className="btn primary" type="button" disabled={working} onClick={() => void decide(true)}>
          Approve
        </button>
        <button className="btn" type="button" disabled={working} onClick={() => void decide(false)}>
          Decline
        </button>
      </div>
    </article>
  );
}
