import type { HostInfo, IdentityRequest, MachineRequest, Now } from "@convoz/api-client";
import { useId, useState } from "react";
import { call, client, humanError } from "../../shared/api.ts";
import { initials, paletteOf } from "../../shared/chat.ts";
import { useNotice } from "../../shared/notice.tsx";

/** A connect request that carries an identity: the agent said who it is, and one tap makes the agent (and the machine, for a new one). */
export type AgentRequest =
  | { kind: "login"; key: string; machine: MachineRequest }
  | { kind: "session"; key: string; request: IdentityRequest };

/** agentRequests are the requests in Now that carry an identity, oldest first. */
export function agentRequests(now: Now | null): AgentRequest[] {
  if (!now) return [];
  return [
    ...now.machine_requests.filter((m) => m.identity).map((machine): AgentRequest => ({ kind: "login", key: `m${machine.id}`, machine })),
    ...now.identity_requests.map((request): AgentRequest => ({ kind: "session", key: request.ref, request })),
  ];
}

const hostInfoLine = (info: HostInfo | null) => (info && [info.hostname, info.os, info.arch, info.cli_version].filter(Boolean).join(" · ")) || "nothing";
const sourceLine = (req: MachineRequest) => `Source: ${req.node_name || "unknown"}${req.source_ip ? ` (${req.source_ip})` : ""}${req.via_internet ? " · via internet" : ""}`;

/**
 * Who is a short block about an agent that asks to connect. The server's own words (the machine name) are never in it: everything
 * here is what the agent sent, shown as plain text under "From the agent", and its picture only as an img of the cleaned SVG (I-32).
 */
function Who({ handle, name, description, avatar, conversation }: { handle: string; name: string; description: string; avatar: string | null; conversation: { title: string } | null }) {
  return (
    <div className="agentintro">
      <p className="sub">From the agent</p>
      <p className="who">
        <span className={`ava p${paletteOf(handle)}`} aria-hidden="true" data-l={avatar ? undefined : initials(handle)}>
          {avatar ? <img src={avatar} alt="" /> : null}
        </span>
        <strong>{name}</strong> <code>{`@${handle}`}</code>
      </p>
      {description ? <p className="role">{description}</p> : null}
      {conversation ? <p className="sub">{`Joins “${conversation.title || "Untitled conversation"}” from now on`}</p> : null}
    </div>
  );
}

interface CardProps {
  item: AgentRequest | { kind: "plain"; key: string; machine: MachineRequest };
  /** Runs after Approve or Decline went through. */
  changed: () => Promise<void> | void;
  /** Runs after an approval; the sheet that waits for an agent to connect says what became of it. */
  approved?: (handle: string) => void;
}

/**
 * RequestCard is one connect request in the feed: a machine (and maybe its agent) or an agent on a machine that is already
 * logged in. Approve and Decline are one tap each: the owner's signed-in session is the authority, there is no passkey check and no code.
 */
export function RequestCard({ item, changed, approved }: CardProps) {
  const { say, fail } = useNotice();
  const id = useId();
  const [busy, setBusy] = useState(false);
  const machine = item.kind === "session" ? null : item.machine;
  const intro = item.kind === "session" ? item.request : (machine?.identity ?? null);
  const name = item.kind === "session" ? item.request.machine : item.machine.name;
  const path = item.kind === "session" ? `/api/identity-requests/${item.request.ref}` : `/api/machines/requests/${item.machine.id}`;

  const decide = async (approve: boolean) => {
    setBusy(true);
    try {
      if (item.kind === "session") {
        const p = { params: { path: { ref: item.request.ref } }, body: {} };
        await call(approve ? client.POST("/api/identity-requests/{ref}/approve", p) : client.POST("/api/identity-requests/{ref}/deny", p));
      } else {
        const p = { params: { path: { id: item.machine.id } } };
        await call(
          approve
            ? client.POST("/api/machines/requests/{id}/approve", { ...p, body: { allow: { mode: "list", identities: [], globs: [] } } })
            : client.POST("/api/machines/requests/{id}/deny", { ...p, body: {} }),
        );
      }
      say(approve ? (intro ? `Approved @${intro.handle}` : `Approved ${name}`) : `Declined ${intro ? `@${intro.handle}` : name}`);
      if (approve && intro) approved?.(intro.handle);
      await changed();
    } catch (err) {
      fail(humanError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <article className="card" aria-labelledby={id} data-request={path}>
      <h3 id={id}>{intro ? `${name} wants to connect as @${intro.handle}` : `${name} wants to connect`}</h3>
      {intro ? (
        <Who handle={intro.handle} name={intro.display_name} description={intro.description} avatar={intro.avatar_url} conversation={intro.conversation} />
      ) : null}
      {machine ? (
        <>
          <p>
            Code: <span className="code">{machine.user_code}</span>
          </p>
          <p className="sub">{`Reported by the machine: ${hostInfoLine(machine.host_info)}`}</p>
          <p className="sub">{sourceLine(machine)}</p>
        </>
      ) : (
        <p className="sub">This machine is already connected.</p>
      )}
      <div className="btns">
        <button className="btn primary" type="button" disabled={busy} onClick={() => void decide(true)}>
          Approve
        </button>
        <button className="btn" type="button" disabled={busy} onClick={() => void decide(false)}>
          Decline
        </button>
      </div>
    </article>
  );
}
