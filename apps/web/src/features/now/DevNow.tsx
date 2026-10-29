import type { Me } from "@convoz/api-client";
import { Button } from "@convoz/ui/Button";
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { call, client, humanError } from "../../shared/api.ts";
import { useNotice } from "../../shared/notice.tsx";
import { markUseful } from "../../shared/perf.ts";
import { data, useData, useLive } from "../../shared/data.ts";
import { agentRequests, RequestCard } from "./requests.tsx";
import { AllClear, NoDecisions } from "./AllClear.tsx";
import { shown, useServerFeed } from "./serverFeed.ts";
import { Folds, type FoldKey } from "./Folds.tsx";
import { NeedsYou } from "./NeedsYou.tsx";
import { useFyi } from "./fyi.ts";
import { unseen, useSeen } from "./seen.ts";
import { NowReplied } from "./NowReplied.tsx";
import { Overdue, useOverdue } from "./Overdue.tsx";
import { PendingAdd } from "./PendingAdd.tsx";
import { Mentions, OtherChats, Replies, unreadRows, useTriage } from "./Unread.tsx";
import { useAskActions } from "./useAskActions.ts";
import { useNow } from "./store.ts";
import { sendKeptLogs } from "../call/index.ts";
import { appPath } from "../../shared/base.ts";

interface NowProps {
  /** Drawn in the desktop rail (proposal §1): no notes and no wordmark, and it polls on its own, since no Now page around it does. */
  compact?: boolean;
  /** The conversation open beside the rail: its items carry aria-current, as a rail row does. */
  current?: number;
}

/** Now is /: what needs the owner. In one list, newest first, with no section headings: the open asks and plan steps that block the owner, and the fyi items (plan steps done today). Then the (urgent, then the newest), the adds agents
 *  wait on, the machines and agents waiting to connect, and the messages that @mention the owner. Then "Replies to you", then the asks the owner replied to and
 *  the agent has not answered, then Other chats; Snoozed, Answered today and Dismissed today fold away above. With nothing waiting, the wordmark, "All clear"
 *  and the folds are centred, in that order. The desktop rail draws the same list `compact`, beside the open conversation (owner, conv 179 msg 6018). */
export function DevNow({ compact = false, current = 0 }: NowProps = {}) {
  const { fail } = useNotice();
  const load = useNow((s) => s.load);
  const now = useNow((s) => s.now);
  const [me, setMe] = useState<Me | null>(null);
  const [onePasskey, setOnePasskey] = useState(false);
  const [folds, setFolds] = useState({ snoozed: false, answered: false, dismissed: false });
  // Agents the owner approved from this feed: each keeps a "@name joined" card with a way to message it.
  const [joined, setJoined] = useState<readonly string[]>([]);
  const deepLinked = useRef(false);

  useEffect(() => void sendKeptLogs(), []);
  useEffect(() => {
    (async () => {
      setMe(await data.loadMe());
      // The passkey count only shapes a hint: with no link it is left out, and Now still shows what the device kept.
      const passkeys = compact
        ? null
        : await call(client.GET("/api/me/passkeys")).then(
            (r) => r.passkeys,
            () => null,
          );
      if (passkeys) setOnePasskey(passkeys.length === 1);
      // The rail's start() below makes the first load; a second one here could let an older answer land last.
      if (!compact) await load();
    })().catch((err) => fail(humanError(err)));
  }, [load, fail, compact]);
  useEffect(() => (compact ? useNow.getState().start() : undefined), [compact]);

  const conversations = useData((s) => s.conversations);
  const mine = useData((s) => s.me?.identity.handle);
  useLive(() => void data.loadConversations().catch(() => {}));
  useEffect(() => {
    data.loadConversations().catch(() => {});
  }, []);
  // Memoised: Now re-renders on every poll of /api/now, and the digest must not (it is the long list).
  const unread = useMemo(() => unreadRows(conversations), [conversations]);
  const { mentions, replies, rest } = useTriage(unread, mine ?? "");

  useEffect(() => {
    // The rail's list is not what the page came for.
    if (now && !compact) markUseful();
  }, [now, compact]);

  const pending = now?.machine_requests ?? null;
  const plain = (pending ?? []).filter((m) => !m.identity);
  const connecting = agentRequests(now);
  const waiting = plain.length + connecting.length;
  const asks = now?.asks ?? [];
  const waitingPlans = now?.waiting_plans ?? [];
  const feed = useServerFeed();
  const cards_ = shown(feed.items, Date.now());
  const skew = useNow((s) => s.skew);
  // A step the server keeps as an item is not also drawn from the plan lines.
  const kept = new Set(feed.items.map((i) => `${i.conversation_id}:${i.handle}`));
  const marks = useSeen((s) => s.marks);
  const fyi = unseen(useFyi(conversations, mine ?? ""), marks, Date.now()).filter((f) => !f.handle || !kept.has(`${f.conversation_id}:${f.handle}`));
  const titles = (id: number) => conversations?.find((c) => c.id === id)?.title ?? "";
  // The owner's questions replace the mention and reply cards; ?old=1 brings the cards back.
  const cards = new URLSearchParams(location.search).get("old") === "1";
  // Held on the device before the "replied" list existed: none then.
  const replied = now?.replied ?? [];
  const adds = now?.pending_adds ?? [];
  const some = Boolean(pending && (waiting || asks.length || adds.length || waitingPlans.length));
  // A deliverable past its date is no decision, but the page is not all clear while one waits (ux spec, conv 179).
  const overdue = useOverdue();
  const clear = Boolean(now) && !some && conversations !== null && (cards ? unread.length === 0 : rest.length === 0) && !overdue.length && !fyi.length && !cards_.length;

  const reload = useCallback(() => load().then(() => undefined), [load]);
  const { busy, presets, answer, dismiss, snooze, unsnooze, reopen } = useAskActions({ now, asks, reload, onAnswered: () => setFolds((f) => ({ ...f, answered: true })) });

  const moveFocus = (e: KeyboardEvent<HTMLElement>) => {
    const step = e.key === "j" ? 1 : e.key === "k" ? -1 : 0;
    const t = e.target as HTMLElement;
    if (!step || e.metaKey || e.ctrlKey || e.altKey || t.tagName === "INPUT" || t.tagName === "TEXTAREA") return;
    const cards = [...e.currentTarget.querySelectorAll<HTMLElement>("[data-ask]")];
    const here = cards.findIndex((c) => c.contains(t));
    cards[Math.min(cards.length - 1, Math.max(0, here + step))]?.focus();
    e.preventDefault();
  };

  const markJoined = (handle: string) => setJoined((j) => (j.includes(handle) ? j : [...j, handle]));

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
    const id = /^\/now\/machine\/(\d+)$/.exec(appPath())?.[1];
    if (id && pending?.some((r) => r.id === Number(id)) && !deepLinked.current) {
      deepLinked.current = true;
      document.querySelector<HTMLElement>(`[data-request="/api/machines/requests/${id}"]`)?.scrollIntoView({ block: "center" });
    }
  }, [pending]);

  return (
    <>
      <div id="notes" hidden={compact}>
        {me?.recovery?.hold_until ? <p className="banner" role="status">{`You signed in with a recovery code. Codes left: ${me.recovery.codes_left}. Some actions are paused for 24 hours.`}</p> : null}
        {onePasskey ? (
          <div className="card note">
            <span>One passkey guards this account.</span>
            <a href="/settings/passkeys">Add a second way in</a>
          </div>
        ) : null}
      </div>
      <AllClear hidden={!clear} compact={compact} />
      {now && !some && !mentions.length && (unread.length || overdue.length) ? <NoDecisions /> : null}
      <Folds
        snoozed={now?.snoozed ?? []}
        answered={now?.answered_today ?? []}
        dismissed={now?.dismissed_today ?? []}
        open={folds}
        toggle={(k: FoldKey) => setFolds((f) => ({ ...f, [k]: !f[k] }))}
        unsnooze={unsnooze}
        reopen={reopen}
        centered={clear}
      />
      <div onKeyDown={moveFocus}>
        <NeedsYou
          asks={asks}
          waiting={waitingPlans}
          fyi={fyi}
          server={{ shown: cards_, all: feed.items, feed, titles, skew }}
          busy={busy}
          presets={presets}
          answer={answer}
          dismiss={dismiss}
          snooze={snooze}
          current={current}
          compact={compact}
        />
      </div>
      {adds.length ? (
        <section id="adds" className="block" aria-label="Adds to decide">
          {adds.map((add) => (
            <PendingAdd key={`${add.conversation.id}-${add.person.id}`} add={add} reload={reload} />
          ))}
        </section>
      ) : null}
      {joined.length ? (
        <section id="joined" className="block" aria-label="Agents that joined">
          {joined.map((handle) => (
            <article key={handle} className="card" aria-label={`@${handle} joined`}>
              <h3>{`@${handle} joined`}</h3>
              <div className="btns">
                <Button variant="primary" href={`/chats/new?with=${encodeURIComponent(handle)}`}>{`Message @${handle}`}</Button>
              </div>
            </article>
          ))}
        </section>
      ) : null}
      <section id="requests-block" className="block" aria-labelledby="requests-heading" hidden={!waiting}>
        <div className="block-head">
          <h2 id="requests-heading">Machine requests</h2>
          <Button id="deny-all" size="small" hidden={!waiting} onClick={denyAll}>
            Deny all
          </Button>
        </div>
        <div id="requests">
          {(pending ?? []).map((req) =>
            req.identity ? (
              <RequestCard key={`m${req.id}`} item={{ kind: "login", key: `m${req.id}`, machine: req }} changed={reload} approved={markJoined} />
            ) : (
              <RequestCard key={`m${req.id}`} item={{ kind: "plain", key: `m${req.id}`, machine: req }} changed={reload} />
            ),
          )}
          {connecting
            .filter((c) => c.kind === "session")
            .map((c) => (
              <RequestCard key={c.key} item={c} changed={reload} approved={markJoined} />
            ))}
        </div>
      </section>
      <Overdue late={overdue} />
      {cards && mentions.length ? <Mentions items={mentions} current={current} /> : null}
      {cards && replies.length ? <Replies items={replies} current={current} /> : null}
      {replied.length ? <NowReplied asks={replied} /> : null}
      {rest.length ? <OtherChats rows={rest} current={current} compact={compact} /> : null}
    </>
  );
}
