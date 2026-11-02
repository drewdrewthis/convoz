import type { Handoff, Session } from "./types.ts";
import { useCallback, useEffect, useState } from "react";
import { call, client, fmtDate, humanError, stepUp } from "../../shared/api.ts";
import { setRegistry } from "../../shared/chat.ts";
import { TriageBadge } from "../../shared/TriageBadge.tsx";
import { data, useData, useLive } from "../../shared/data.ts";
import { useNotice } from "../../shared/notice.tsx";
import { StepUpSheet, useSheets } from "../../shared/sheets.tsx";
import { Ring } from "./Avatar.tsx";
import { nameOf } from "./Crew.tsx";
import { ago, labelOf, shownState } from "./status.ts";
import { useCrew } from "./store.ts";
import { Button } from "@convoz/ui/Button";
import { EmptyState } from "@convoz/ui/EmptyState";
import { Field } from "@convoz/ui/Field";
import { List, ListRow } from "@convoz/ui/ListRow";
import { appPath } from "../../shared/base.ts";

const TABS = ["Sessions", "Handoffs"] as const;

/** AgentProfile is /crew/<handle>: who the agent is, what waits on the owner, the shared conversations, its sessions and notes. */
export function AgentProfile() {
  const { say, fail } = useNotice();
  const asked = decodeURIComponent(appPath().split("/")[2] ?? "");
  const everyone = useData((s) => s.identities);
  const conversations = useData((s) => s.conversations);
  const statuses = useCrew((s) => s.statuses);
  const [tab, setTab] = useState<(typeof TABS)[number]>("Sessions");
  const [confirming, setConfirming] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [newHandle, setNewHandle] = useState("");
  const { sheet, open } = useSheets();
  // A link may name a handle the agent had before (I-51): it still finds the agent, shown under its handle now.
  const who = everyone?.find((p) => p.kind === "agent" && (p.handle === asked || (p.previous_handles ?? []).includes(asked)));
  const handle = who?.handle ?? asked;
  const everySession = useLoaded<Session[]>(useCallback(async () => (await call(client.GET("/api/sessions"))).sessions.filter((s) => s.identity === handle), [handle]));

  const reload = useCallback(async () => {
    await Promise.all([data.loadIdentities(), data.loadConversations(), useCrew.getState().load()]);
  }, []);
  useLive(() => void reload().catch(() => {}));
  useEffect(() => {
    reload().catch((err) => fail(humanError(err)));
  }, [fail, reload]);

  if (!everyone || !statuses) return <div className="crew" aria-busy="true" />;
  setRegistry(everyone);
  if (!who) return <EmptyState>That agent is not on Crew.</EmptyState>;
  const status = statuses[handle];
  const shown = who.disabled ? "offline" : shownState(who.online, status?.state);
  const together = (conversations ?? []).filter((c) => c.participants.some((p) => p.handle === handle));
  const asks = status?.open_asks ?? [];
  const machines = [...new Set((everySession ?? []).map((x) => x.machine))];
  const setTriage = (on: boolean) =>
    open((close) => (
      <StepUpSheet
        title={on ? "Make this a triage agent" : "Stop being a triage agent"}
        intro={on ? `@${handle} will read every conversation and thread, post in them as itself, and add or remove agents in any chat. This needs a passkey check.` : `@${handle} will only read and change the conversations it is in.`}
        confirm={on ? "Allow" : "Turn off"}
        action="identity.triage"
        target={who.id}
        close={close}
        perform={async (stepId) => {
          await call(client.PUT("/api/agents/{id}/triage", { params: { path: { id: who.id }, header: stepUp(stepId) }, body: { on } }));
          await reload();
        }}
      />
    ));

  return (
    <div className="crew profile">
      <header className="phead">
        <Ring handle={handle} shown={shown} />
        <div className="ptxt">
          <h2>{nameOf(who)}</h2>
          {who.triage ? (
            <p>
              <TriageBadge handle={handle} />
            </p>
          ) : null}
          <p className="pstate">{who.disabled ? "Disabled" : labelOf(shown, status?.open_asks.length ?? 0)}</p>
          {who.previous_handles?.length ? <p className="text-muted">{`Was @${who.previous_handles.join(", @")}`}</p> : null}
          {who.description ? <p className="text-muted">{who.description}</p> : null}
          {!who.disabled && status?.doing ? <p>{`Doing: ${status.doing}`}</p> : null}
          {!who.disabled && status?.next ? <p>{`Next: ${status.next}`}</p> : null}
        </div>
      </header>
      {who.disabled ? null : (
        <Button className="self-start" variant="primary" href={`/chats/new?with=${encodeURIComponent(handle)}`} aria-label={`New conversation with @${handle}`}>
          New conversation
        </Button>
      )}

      {asks.length ? (
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
      ) : null}

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

      <section className="cgrp" aria-label="Details">
        <h3>Details</h3>
        <div className="keyrow">
          <span>{who.disabled ? "Key revoked" : `Created ${fmtDate(who.created_at)} · last used ${lastUsed(everySession)}`}</span>
          {who.disabled || confirming || renaming ? null : (
            <>
              <Button className="self-start" size="small" onClick={() => setRenaming(true)}>
                Change handle
              </Button>
              <Button className="self-start" variant="danger" size="small" onClick={() => setConfirming(true)}>
                Revoke key
              </Button>
            </>
          )}
        </div>
        {who.disabled ? null : (
          <div className="triageset">
            <List as="div">
              <Field type="checkbox" label="Triage agent" checked={!!who.triage} onChange={(e) => setTriage(e.target.checked)} />
            </List>
            <p className="hint">{`Reads every conversation and thread, posts in any of them, and can add or remove agents in any chat, itself included. It can't answer your asks. Any process that can sign in as @${handle} on ${machines.length ? machines.join(", ") : "a machine that allows it"} gets this.`}</p>
          </div>
        )}
        {renaming && !who.disabled ? (
          <form
            role="group"
            aria-label="Change handle"
            className="revoke"
            onSubmit={(e) => {
              e.preventDefault();
              const next = newHandle.trim().toLowerCase().replace(/^@/, "");
              void call(client.POST("/api/identities/{id}/handle", { params: { path: { id: who.id } }, body: { handle: next } }))
                .then(async (r) => {
                  say(`@${r.identity.previous_handle} is now @${r.identity.handle}`);
                  history.replaceState(null, "", `/crew/${encodeURIComponent(r.identity.handle)}`);
                  setRenaming(false);
                  setNewHandle("");
                  await reload();
                })
                .catch((err) => fail(humanError(err)));
            }}
          >
            <input aria-label="New handle" value={newHandle} autoCapitalize="off" autoCorrect="off" spellCheck={false} onChange={(e) => setNewHandle(e.target.value)} />
            <span>{`The old handle is never used again. Mentions of it still reach @${handle}. A handle changes once in 30 days.`}</span>
            <div className="btns">
              <Button className="self-start" type="submit" variant="primary">
                Save
              </Button>
              <Button className="self-start" variant="quiet" onClick={() => setRenaming(false)}>
                Cancel
              </Button>
            </div>
          </form>
        ) : null}
        {confirming && !who.disabled ? (
          <div role="group" aria-label="Revoke key" className="revoke">
            <span>{`Revoke the key for @${handle}? It disconnects right away and cannot be undone. Its handle is never used again, and its messages stay.`}</span>
            <div className="btns">
              <Button
                className="self-start"
                variant="danger"
                aria-label="Confirm revoke key"
                onClick={() =>
                  void call(client.POST("/api/identities/{id}/disable", { params: { path: { id: who.id } }, body: {} }))
                    .then(() => reload())
                    .catch((err) => fail(humanError(err)))
                    .finally(() => setConfirming(false))
                }
              >
                Confirm
              </Button>
              <Button className="self-start" variant="quiet" onClick={() => setConfirming(false)}>
                Cancel
              </Button>
            </div>
          </div>
        ) : null}
      </section>
      {sheet}
    </div>
  );
}

/** lastUsed is when the agent's newest session was last seen, "never" before it had one. */
function lastUsed(sessions: Session[] | null): string {
  if (!sessions) return "…";
  const newest = Math.max(0, ...sessions.map((s) => s.last_seen_at));
  return newest ? ago(newest) : "never";
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
  if (!list.length) return <EmptyState>No live sessions.</EmptyState>;
  return (
    <List aria-label="Sessions">
      {list.map((s) => (
        <ListRow key={s.id} stacked>
          <strong>{s.label}</strong>
          <span className="text-13 text-muted">{`on ${s.machine} · last seen ${ago(s.last_seen_at)}`}</span>
        </ListRow>
      ))}
    </List>
  );
}

function Handoffs({ handle }: { handle: string }) {
  const list = useLoaded<Handoff[]>(useCallback(async () => (await call(client.GET("/api/handoffs", { params: { query: { identity: handle } } }))).handoffs, [handle]));
  if (!list) return null;
  if (!list.length) return <EmptyState>No handoff notes.</EmptyState>;
  return (
    <List aria-label="Handoff notes">
      {list.map((h) => (
        <ListRow key={h.id} stacked>
          <span>{h.body}</span>
          <span className="text-13 text-muted">{`${h.session} on ${h.machine} · ${ago(h.created_at)}`}</span>
        </ListRow>
      ))}
    </List>
  );
}
