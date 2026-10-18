import { Sheet } from "@convoz/ui/Sheet";
import { useEffect, useMemo, useRef, useState } from "react";
import { humanError } from "../../shared/api.ts";
import { data, useData } from "../../shared/data.ts";
import { useNotice } from "../../shared/notice.tsx";
import { agentRequests, RequestCard, useNow, type AgentRequest } from "../now/index.ts";
import { fetchAgentUrl, invitePrompt } from "./invitePrompt.ts";

interface Props {
  close: () => void;
  /** Set when the sheet was opened from a conversation: the agent joins it once approved. */
  conversation?: { id: number; title: string };
}

const handleOf = (r: AgentRequest) => (r.kind === "login" ? r.machine.identity!.handle : r.request.handle);

/**
 * InviteAgentSheet has no form. It is one prompt to copy; the agent runs convoz with it and sends its own identity, and the request
 * shows up here live, as a card with Approve and Decline. The sheet then says the agent is connected (prototype v41: "Waiting for an
 * agent to connect…", "Connected: X is online", "New thread with X").
 */
export default function InviteAgentSheet({ close, conversation }: Props) {
  const { fail } = useNotice();
  const now = useNow((s) => s.now);
  const people = useData((s) => s.identities);
  const [copied, setCopied] = useState(false);
  const [alert, setAlert] = useState("");
  const [connected, setConnected] = useState<string | null>(null);
  const baseline = useRef<Set<string> | null>(null);
  const tracked = useRef<{ key: string; handle: string } | null>(null);
  const [agentUrl, setAgentUrl] = useState<string | null>(null);
  // An agent outside the tailnet cannot reach this page's address; the server says where it can connect, when it has such an address.
  const prompt = useMemo(() => invitePrompt({ server: agentUrl ?? location.origin, conversation }), [agentUrl, conversation]);

  useEffect(() => {
    const stop = useNow.getState().start();
    useNow.getState().load().catch((err) => fail(humanError(err)));
    data.loadIdentities().catch(() => {});
    fetchAgentUrl().then(setAgentUrl, () => {});
    return stop;
  }, [fail]);

  const all = agentRequests(now);
  // Only a request that arrives while the sheet is open is the one this prompt was for.
  if (now && !baseline.current) baseline.current = new Set(all.map((r) => r.key));
  const fresh = all.find((r) => baseline.current && !baseline.current.has(r.key));
  if (fresh) tracked.current = { key: fresh.key, handle: handleOf(fresh) };

  // The request left the feed: the owner decided it somewhere else (Now, another tab). If the agent exists now, it is connected.
  const left = Boolean(tracked.current) && !all.some((r) => r.key === tracked.current!.key);
  useEffect(() => {
    if (left) data.loadIdentities().catch(() => {});
  }, [left]);
  const elsewhere = left ? people?.find((p) => p.handle === tracked.current!.handle && !p.disabled)?.handle : undefined;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(prompt);
      setCopied(true);
      setAlert("");
    } catch {
      setAlert("Copying did not work. Select the prompt and copy it by hand.");
    }
  };

  const doneHandle = connected ?? elsewhere ?? null;
  const done = doneHandle ? people?.find((p) => p.handle === doneHandle) : undefined;
  const name = done?.display_name ?? doneHandle;
  const where = conversation ? ` and in “${conversation.title || "Untitled conversation"}”` : "";

  return (
    <Sheet
      title="Invite agent"
      alert={alert}
      onClose={close}
      actions={
        doneHandle ? (
          <>
            <a className="btn primary" href={`/chats/new?with=${encodeURIComponent(doneHandle)}`}>{`New thread with ${name}`}</a>
            <button className="btn" type="button" onClick={close}>
              Done
            </button>
          </>
        ) : (
          <>
            <button className="btn primary" type="button" onClick={() => void copy()}>
              {copied ? "Copied" : "Copy"}
            </button>
            <button className="btn quiet" type="button" onClick={close}>
              Close
            </button>
          </>
        )
      }
    >
      {doneHandle ? (
        <p role="status" className="lead">{`Connected: ${name} is online${where}.`}</p>
      ) : (
        <>
          <p className="muted">
            Paste this into the agent. It works once. Messages and asks go to conversations. Status goes to the agent and shows on its profile.
            {conversation ? ` It joins “${conversation.title || "Untitled conversation"}”.` : ""}
          </p>
          <pre tabIndex={0} aria-label="Connect prompt" className="prompt">
            {prompt}
          </pre>
          {fresh ? (
            <RequestCard item={fresh} changed={() => useNow.getState().load().then(() => undefined)} approved={(h) => setConnected(h)} />
          ) : (
            <p role="status" className="hint">
              Waiting for an agent to connect…
            </p>
          )}
        </>
      )}
    </Sheet>
  );
}
