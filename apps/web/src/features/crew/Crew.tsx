import type { Identity } from "@convoz/api-client";
import type { CrewStatus } from "./types.ts";
import { MachineIcon, PlusIcon, SearchIcon } from "@convoz/ui/icons";
import type { ReactNode } from "react";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { humanError } from "../../shared/api.ts";
import { setRegistry } from "../../shared/chat.ts";
import { data, useData, useLive } from "../../shared/data.ts";
import { useNotice } from "../../shared/notice.tsx";
import { useSheets } from "../../shared/sheets.tsx";
import { Ring } from "./Avatar.tsx";
import { GROUPS, LOOK, sameName, shownState, type Shown } from "./status.ts";
import { useCrew } from "./store.ts";

// The sheet is a chunk of its own: the list pays for it only when the owner adds an agent.
const InviteAgentSheet = lazy(() => import("./InviteAgentSheet.tsx"));

/** nameOf is "Search Dev @dev-search", or the handle alone when the display name only repeats it (I-3). */
export const nameOf = (p: Pick<Identity, "handle" | "display_name">): string => (sameName(p) ? p.handle : `${p.display_name} @${p.handle}`);

interface Row {
  who: Identity;
  shown: Shown;
  status: CrewStatus | undefined;
}

/** statusLine is "Working · Fixing #412"; an idle agent that is there reads "Idle · Online and ready". */
function statusLine(r: Row): string {
  const look = LOOK[r.shown].label;
  const doing = r.status?.doing;
  if (r.shown === "offline") return look;
  if (doing && r.shown !== "idle") return `${look} · ${doing}`;
  return r.shown === "idle" ? `${look} · ${doing || "Online and ready"}` : look;
}

/** Crew is /crew: the agents grouped by what they are doing, who is waiting on the owner first. */
export function Crew() {
  const { fail } = useNotice();
  const everyone = useData((s) => s.identities);
  const statuses = useCrew((s) => s.statuses);
  const [q, setQ] = useState("");
  const [showDisabled, setShowDisabled] = useState(false);
  const { sheet, open } = useSheets();
  const search = useRef<HTMLInputElement>(null);
  // The dock opens with the search field ready, as the prototype's does; a phone would raise its keyboard, so only a wide window.
  useEffect(() => {
    if (matchMedia("(min-width: 900px)").matches) search.current?.focus();
  }, []);

  const reload = useCallback(async () => {
    await Promise.all([data.loadIdentities(), useCrew.getState().load()]);
  }, []);
  useLive(() => void reload().catch(() => {}));
  useEffect(() => {
    reload().catch((err) => fail(humanError(err)));
  }, [fail, reload]);

  const agents = useMemo(() => {
    if (!everyone) return null;
    setRegistry(everyone);
    return everyone.filter((p) => p.kind === "agent");
  }, [everyone]);
  const rows: Row[] | null = useMemo(
    () => (agents && statuses ? agents.map((who) => ({ who, status: statuses[who.handle], shown: shownState(who.online, statuses[who.handle]?.state) })) : null),
    [agents, statuses],
  );
  const want = q.trim().toLowerCase();
  const matches = (r: Row) => `${r.who.handle} ${r.who.display_name} ${r.status?.doing ?? ""}`.toLowerCase().includes(want);
  const enabled = (rows ?? []).filter((r) => !r.who.disabled);
  const disabled = (rows ?? []).filter((r) => r.who.disabled && matches(r));
  const shown = enabled.filter(matches);
  const working = enabled.filter((r) => r.shown === "working").length;
  const waiting = enabled.filter((r) => r.shown === "waiting" || r.shown === "blocked").length;
  const online = enabled.filter((r) => r.shown !== "offline").length;
  const live = enabled.filter((r) => r.shown === "working" || r.shown === "waiting" || r.shown === "blocked");
  const faces = live.length ? live : enabled;
  const add = useCallback(() => open((close) => <Suspense fallback={null}><InviteAgentSheet close={close} /></Suspense>), [open]);
  // The rail's "Invite agent" lands here as /crew?invite and opens the sheet at once.
  useEffect(() => {
    if (new URLSearchParams(location.search).has("invite")) {
      history.replaceState(null, "", location.pathname);
      add();
    }
  }, [add]);
  const summary = working || waiting ? [working && `${working} working`, waiting && `${waiting} waiting on you`].filter(Boolean).join(" · ") : enabled.length ? `${online} online` : "";

  return (
    <div id="crew" className="crew" aria-busy={rows ? undefined : true}>
      <header className="dockhead">
        <h2>Crew</h2>
        <span className="count" aria-label={`${enabled.length} agents`}>{enabled.length}</span>
        <span className="sp" />
        <a className="iconbtn" href="/" aria-label="Close agents panel">
          <CloseIcon />
        </a>
      </header>
      <div className="crew-top">
        <div id="crew-faces" className="stack-av">
          {faces.slice(0, 5).map((r) => (
            <Ring key={r.who.handle} handle={r.who.handle} shown={r.shown} quiet avatar={r.who.avatar_url} />
          ))}
        </div>
        <span id="crew-sum" className="sum">
          {summary}
        </span>
        <button type="button" className="addagent" onClick={add}>
          <PlusIcon />
          Add agent
        </button>
      </div>
      <div>
        <label className="fld">
          <span className="sr">Find an agent</span>
          <SearchIcon />
          <input ref={search} id="crew-q" type="text" placeholder="Find an agent" autoComplete="off" value={q} onChange={(e) => setQ(e.target.value)} />
        </label>
      </div>
      <div className="docklist">
      {GROUPS.map((g) => {
        const inGroup = shown.filter((r) => (g.shown as readonly Shown[]).includes(r.shown));
        return (
          <section key={g.key} id={g.key === "idle" ? "crew-idle" : undefined} className="cgrp" data-group={g.key} aria-label={g.label} hidden={inGroup.length === 0}>
            <h3>
              <i aria-hidden="true" />
              <span>{g.label}</span> <b id={g.key === "idle" ? "crew-count" : undefined}>{`· ${inGroup.length}`}</b>
            </h3>
            <ul id={g.key === "idle" ? "crew-list" : undefined} role="list" aria-label={g.label === "Idle" ? "Agents" : `${g.label} agents`}>
              {inGroup.map((r) => (
                <AgentRow key={r.who.handle} r={r} />
              ))}
            </ul>
          </section>
        );
      })}
      <p id="crew-empty" className="empty" hidden={!agents || enabled.length !== 0 || disabled.length !== 0}>
        No agents yet. Connect a machine and add an agent first.
      </p>
      <a className="dashed" href="/crew/machines">
        <MachineIcon />
        Machines
      </a>
      {disabled.length ? (
        <section className="cgrp" aria-label="Disabled">
          <h3>
            <button type="button" className="disclose" aria-expanded={showDisabled} onClick={() => setShowDisabled((v) => !v)}>
              {`Disabled · ${disabled.length}`}
            </button>
          </h3>
          <ul role="list" aria-label="Disabled agents" hidden={!showDisabled}>
            {disabled.map((r) => (
              <AgentRow key={r.who.handle} r={r} />
            ))}
          </ul>
        </section>
      ) : null}
      </div>
      <footer className="dockfoot">
        <button type="button" onClick={add}>
          <InviteIcon />
          Invite agent
        </button>
      </footer>
      {sheet}
    </div>
  );
}

const svg = (paths: ReactNode) => () => (
  <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    {paths}
  </svg>
);
const CloseIcon = svg(<path d="M6 6l12 12M18 6L6 18" />);
const InviteIcon = svg(<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM19 8v6M22 11h-6" />);

function AgentRow({ r }: { r: Row }) {
  const asks = r.status?.open_asks.length ?? 0;
  return (
    <li>
      <a className="crow" href={`/crew/${encodeURIComponent(r.who.handle)}`}>
        <Ring handle={r.who.handle} shown={r.who.disabled ? "offline" : r.shown} avatar={r.who.avatar_url} />
        <span className="txt">
          <span className="nm">{nameOf(r.who)}</span>
          <span className="st">{r.who.disabled ? "Disabled" : statusLine(r)}</span>
        </span>
        {asks ? <span className="chip">{`${asks} ${asks === 1 ? "ask" : "asks"}`}</span> : null}
      </a>
    </li>
  );
}
