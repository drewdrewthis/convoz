import type { HostInfo, MachineRequest, Me } from "@convoz/api-client";
import { Wordmark } from "@convoz/ui/Wordmark";
import { TickIcon } from "@convoz/ui/icons";
import { useEffect, useId, useState } from "react";
import { call, client, humanError, stepUp } from "../../shared/api.ts";
import { useNotice } from "../../shared/notice.tsx";
import { StepUpSheet, useSheets } from "../../shared/sheets.tsx";
import { data } from "../../shared/data.ts";
import { useNow } from "./store.ts";
import { parseAllow } from "../crew/index.ts";

/** Now is /: what needs the owner. Today that is machines waiting to connect (each one an ask); with nothing waiting, "All clear". */
export function Now() {
  const { say, fail } = useNotice();
  const loadRequests = useNow((s) => s.loadMachineRequests);
  const pending = useNow((s) => s.machineRequests);
  const { sheet, open } = useSheets();
  const [me, setMe] = useState<Me | null>(null);
  const [onePasskey, setOnePasskey] = useState(false);

  useEffect(() => {
    (async () => {
      setMe(await data.loadMe());
      const { passkeys } = await call(client.GET("/api/me/passkeys"));
      setOnePasskey(passkeys.length === 1);
      await loadRequests();
    })().catch((err) => fail(humanError(err)));
  }, [loadRequests, fail]);

  const reload = () => loadRequests().then(() => undefined);
  const denyAll = async () => {
    try {
      await call(client.POST("/api/machines/requests/deny-all", { body: {} }));
      await reload();
    } catch (err) {
      fail(humanError(err));
    }
  };
  const some = Boolean(pending && pending.length);

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
      <div id="allclear" hidden={!pending || some}>
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
      <section id="requests-block" className="block" aria-labelledby="requests-heading" hidden={!some}>
        <div className="block-head">
          <h2 id="requests-heading">Machine requests</h2>
          <button id="deny-all" className="btn small" type="button" hidden={!some} onClick={denyAll}>
            Deny all
          </button>
        </div>
        <div id="requests">
          {(pending ?? []).map((req) => (
            <RequestCard
              key={req.id}
              req={req}
              reload={reload}
              approve={() =>
                open((close) => (
                  <StepUpSheet
                    title={`Approve ${req.name}`}
                    fields={[
                      { key: "allowed", label: "Allowed identities", hint: "Agents this machine may act as: handles and patterns such as dev-*, separated by commas." },
                      ...(pending!.length > 1
                        ? [{ key: "typed", label: "Type the code", hint: "Several machines are waiting. Type the code the machine printed.", attrs: { className: "code-input" } }]
                        : []),
                    ]}
                    confirm="Approve"
                    action="machine.approve"
                    target={req.id}
                    close={close}
                    perform={async (stepId, values) => {
                      const body: { allow: ReturnType<typeof parseAllow>; typed_code?: string } = { allow: parseAllow(values.allowed ?? "") };
                      if (values.typed !== undefined) body.typed_code = values.typed.trim();
                      await call(client.POST("/api/machines/requests/{id}/approve", { params: { path: { id: req.id }, header: stepUp(stepId) }, body }));
                      say(`Approved ${req.name}`);
                      await reload();
                    }}
                  />
                ))
              }
            />
          ))}
        </div>
      </section>
      {sheet}
    </>
  );
}

const hostInfoLine = (info: HostInfo | null) => (info && [info.hostname, info.os, info.arch, info.cli_version].filter(Boolean).join(" · ")) || "nothing";

const sourceLine = (req: MachineRequest) => `Source: ${req.node_name || "unknown"}${req.source_ip ? ` (${req.source_ip})` : ""}`;

/** RequestCard is one machine waiting to connect: its code, what it reports about itself, and Approve or Deny. */
function RequestCard({ req, reload, approve }: { req: MachineRequest; reload: () => Promise<void>; approve: () => void }) {
  const { say, fail } = useNotice();
  const id = useId();
  const [denying, setDenying] = useState(false);
  const deny = async () => {
    setDenying(true);
    try {
      await call(client.POST("/api/machines/requests/{id}/deny", { params: { path: { id: req.id } }, body: {} }));
      say(`Denied ${req.name}`);
      await reload();
    } catch (err) {
      fail(humanError(err));
      setDenying(false);
    }
  };
  return (
    <article className="card" aria-labelledby={id}>
      <h3 id={id}>{`${req.name} wants to connect`}</h3>
      <p>
        Code: <span className="code">{req.user_code}</span>
      </p>
      <p className="sub">{`Reported by the machine: ${hostInfoLine(req.host_info)}`}</p>
      <p className="sub">{sourceLine(req)}</p>
      <div className="btns">
        <button className="btn primary" type="button" onClick={approve}>
          Approve
        </button>
        <button className="btn" type="button" disabled={denying} onClick={deny}>
          Deny
        </button>
      </div>
    </article>
  );
}
