import { MachineIcon, SearchIcon } from "@convoz/ui/icons";
import { useEffect, useMemo, useState } from "react";
import { setRegistry } from "../../shared/chat.ts";
import { useNotice } from "../../shared/notice.tsx";
import { data, useData } from "../../shared/data.ts";
import { Ring } from "./Avatar.tsx";

/** Crew is /crew: the agents. The server knows only whether an agent has a live session, so every agent is Idle: online and ready, or offline. */
export function Crew() {
  const { fail } = useNotice();
  const everyone = useData((s) => s.identities);
  const [q, setQ] = useState("");
  useEffect(() => {
    data.loadIdentities().catch((err) => fail((err && err.message) || "Something went wrong. Try again."));
  }, [fail]);

  const people = useMemo(() => {
    if (!everyone) return null;
    setRegistry(everyone);
    return everyone.filter((p) => p.kind === "agent" && !p.disabled);
  }, [everyone]);
  const want = q.trim().toLowerCase();
  const shown = (people ?? []).filter((p) => p.handle.includes(want));
  const online = (people ?? []).filter((p) => p.online).length;

  return (
    <div id="crew" className="crew" aria-busy={people ? undefined : true}>
      <div className="crew-top">
        <div id="crew-faces" className="stack-av">
          {(people ?? []).slice(0, 5).map((p) => (
            <Ring key={p.handle} handle={p.handle} />
          ))}
        </div>
        <span id="crew-sum" className="sum">
          {people?.length ? `${online} online` : ""}
        </span>
      </div>
      <div>
        <label className="fld">
          <span className="sr">Find an agent</span>
          <SearchIcon />
          <input id="crew-q" type="text" placeholder="Find an agent" autoComplete="off" value={q} onChange={(e) => setQ(e.target.value)} />
        </label>
      </div>
      <section id="crew-idle" className="cgrp" aria-label="Idle" hidden={!people || shown.length === 0}>
        <h3>
          <i aria-hidden="true" />
          <span>Idle</span> <b id="crew-count">{`· ${shown.length}`}</b>
        </h3>
        <ul id="crew-list" role="list" aria-label="Agents">
          {shown.map((p) => (
            <li key={p.handle}>
              <a className="crow" href={`/chats/new?with=${encodeURIComponent(p.handle)}`}>
                <Ring handle={p.handle} />
                <span className="txt">
                  <span className="nm">{p.handle}</span>
                  <span className="st">{`Idle · ${p.online ? "Online and ready" : "Offline"}`}</span>
                </span>
              </a>
            </li>
          ))}
        </ul>
      </section>
      <p id="crew-empty" className="empty" hidden={!people || people.length !== 0}>
        No agents yet. Connect a machine and add an agent first.
      </p>
      <a className="dashed" href="/crew/machines">
        <MachineIcon />
        Machines
      </a>
    </div>
  );
}
