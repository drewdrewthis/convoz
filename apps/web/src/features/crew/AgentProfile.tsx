import type { Handoff, Session } from "./types.ts";
import { useCallback, useEffect, useState } from "react";
import { call, client, humanError, stepUp } from "../../shared/api.ts";
import { setRegistry } from "../../shared/chat.ts";
import { data, useData, useLive } from "../../shared/data.ts";
import { useNotice } from "../../shared/notice.tsx";
import { StepUpSheet, useSheets } from "../../shared/sheets.tsx";
import { Ring } from "./Avatar.tsx";
import { nameOf } from "./Crew.tsx";
import { ago, LOOK, shownState } from "./status.ts";
import { useCrew } from "./store.ts";

const TABS = ["Sessions", "Handoffs"] as const;

/** AgentProfile is /crew/<handle>: who the agent is, what waits on the owner, the shared conversations, its sessions and notes. */
export function AgentProfile() {
  const { fail } = useNotice();
  const handle = decodeURIComponent(location.pathname.split("/")[2] ?? "");
  const everyone = useData((s) => s.identities);
  const conversations = useData((s) => s.conversations);
  const statuses = useCrew((s) => s.statuses);
  const [tab, setTab] = useState<(typeof TABS)[number]>("Sessions");
  const { sheet, open } = useSheets();

  const reload = useCallback(async () => {
    await Promise.all([data.loadIdentities(), data.loadConversations(), useCrew.getState().load()]);
  }, []);
  useLive(() => void reload().catch(() => {}));
  useEffect(() => {
    reload().catch((err) => fail(humanError(err)));
  }, [fail, reload]);

  if (!everyone || !statuses) return <div className="crew" aria-busy="true" />;
  setRegistry(everyone);
  const who = everyone.find((p) => p.kind === "agent" && p.handle === handle);
  if (!who) return <p className="empty">That agent is not on Crew.</p>;
  const status = statuses[handle];
  const shown = who.disabled ? "offline" : shownState(who.online, status?.state);
  const together = (conversations ?? []).filter((c) => c.participants.some((p) => p.handle === handle));
  const asks = status?.open_asks ?? [];

  return (
    <div className="crew profile">
      <header className="phead">
        <Ring handle={handle} shown={shown} />
        <div className="ptxt">
          <h2>{nameOf(who)}</h2>
          <p className="pstate">{who.disabled ? "Disabled" : LOOK[shown].label}</p>
          {who.description ? <p className="muted">{who.description}</p> : null}
          {!who.disabled && status?.doing ? <p>{`Doing: ${status.doing}`}</p> : null}
          {!who.disabled && status?.next ? <p>{`Next: ${status.next}`}</p> : null}
        </div>
      </header>
      {who.disabled ? null : (
        <a className="btn primary" href={`/chats/new?with=${encodeURIComponent(handle)}`} aria-label={`New conversation with @${handle}`}>
          New conversation
        </a>
      )}

      <section className="cgrp" aria-label="Waiting on you">
        <h3>{`Waiting on you · ${asks.length}`}</h3>
        <ul role="list">
          {asks.map((a) => (
            <li key={a.id}>
              <a className="crow plain" href={`/chats/${a.conversation_id}#m${a.id}`}>
                <span className="txt">
                  <span className="nm">{a.question}</span>
                </span>
              </a>
            </li>
          ))}
        </ul>
      </section>

      <section className="cgrp" aria-label="Conversations together">
        <h3>{`Conversations together · ${together.length}`}</h3>
        <ul role="list">
          {together.map((c) => (
            <li key={c.id}>
              <a className="crow plain" href={`/chats/${c.id}`}>
                <span className="txt">
                  <span className="nm">{c.title || "New conversation"}</span>
                </span>
              </a>
            </li>
          ))}
        </ul>
      </section>

      <div role="tablist" aria-label="Agent details" className="ptabs">
        {TABS.map((t) => (
          <button key={t} role="tab" type="button" aria-selected={tab === t} onClick={() => setTab(t)}>
            {t}
          </button>
        ))}
      </div>
      <div role="tabpanel" aria-label={tab}>
        {tab === "Sessions" ? <Sessions handle={handle} /> : <Handoffs handle={handle} />}
      </div>

      {who.disabled ? null : (
        <button
          type="button"
          className="btn danger"
          onClick={() =>
            open((close) => (
              <StepUpSheet
                title={`Disable @${handle}`}
                intro="Its sessions end at once and its open asks close. Its handle is never used again, and its messages stay."
                confirm="Disable"
                tone="danger"
                action="identity.disable"
                target={who.id}
                close={close}
                perform={async (stepId) => {
                  await call(client.POST("/api/identities/{id}/disable", { params: { path: { id: who.id }, header: stepUp(stepId) }, body: {} }));
                  await reload();
                }}
              />
            ))
          }
        >
          Disable
        </button>
      )}
      {sheet}
    </div>
  );
}

function useLoaded<T>(load: () => Promise<T>): T | null {
  const { fail } = useNotice();
  const [value, setValue] = useState<T | null>(null);
  useEffect(() => {
    load().then(setValue, (err) => fail(humanError(err)));
  }, [load, fail]);
  return value;
}

function Sessions({ handle }: { handle: string }) {
  const list = useLoaded<Session[]>(useCallback(async () => (await call(client.GET("/api/sessions"))).sessions.filter((s) => s.identity === handle && s.state === "live"), [handle]));
  if (!list) return null;
  if (!list.length) return <p className="empty">No live sessions.</p>;
  return (
    <ul className="group" aria-label="Sessions">
      {list.map((s) => (
        <li key={s.id} className="row stacked">
          <strong>{s.label}</strong>
          <span className="sub">{`on ${s.machine} · last seen ${ago(s.last_seen_at)}`}</span>
        </li>
      ))}
    </ul>
  );
}

function Handoffs({ handle }: { handle: string }) {
  const list = useLoaded<Handoff[]>(useCallback(async () => (await call(client.GET("/api/handoffs", { params: { query: { identity: handle } } }))).handoffs, [handle]));
  if (!list) return null;
  if (!list.length) return <p className="empty">No handoff notes.</p>;
  return (
    <ul className="group" aria-label="Handoff notes">
      {list.map((h) => (
        <li key={h.id} className="row stacked">
          <span>{h.body}</span>
          <span className="sub">{`${h.session} on ${h.machine} · ${ago(h.created_at)}`}</span>
        </li>
      ))}
    </ul>
  );
}
