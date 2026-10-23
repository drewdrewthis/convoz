import { IconButton } from "@convoz/ui/IconButton";
import type { Conversation, Person, PlanBoard } from "@convoz/api-client";
import { Field } from "@convoz/ui/Field";
import { Sheet } from "@convoz/ui/Sheet";
import { useEffect, useRef, useState } from "react";
import { humanError } from "../../shared/api.ts";
import { fmtDate } from "../../shared/api.ts";
import { stripCf } from "../../shared/chat.ts";
import { data } from "../../shared/data.ts";
import { useNotice } from "../../shared/notice.tsx";
import { useSheets, CancelButton } from "../../shared/sheets.tsx";
import { PinnedList, toast } from "../pins-stars/index.ts";
import { setMute } from "../rail/index.ts";
import { AddAgentSheet } from "./AddAgentSheet.tsx";
import { addAgent, decideAdd, deleteConversation, markAllRead, removeAgent, rename } from "./actions.ts";
import { AgentsSection, WaitingSection, type PlanActions } from "./PlanSections.tsx";
import { Button } from "@convoz/ui/Button";

export interface DetailsProps {
  row: Conversation;
  onClose(): void;
  /** Opens the sheet that invites a new agent into this conversation. */
  onInvite(): void;
  /** The plans of this conversation (GET /api/plans?conversation=), once read. */
  board?: PlanBoard;
  /** Post a message as the owner, or start one in the composer. */
  act: PlanActions;
}

/**
 * Details is the panel "Details for <title>" (key I, or a tap on the line under the title). In the order of the UX pass approved for
 * phase 1: what waits on the owner, then one card per agent with its plan, then how the conversation is set and what the owner can do
 * to it. On a phone it is a bottom sheet at 80% of the height; on a wide screen it sits at the right edge.
 */
export function Details({ row, onClose, onInvite, board, act }: DetailsProps) {
  const { fail } = useNotice();
  const { sheet, open } = useSheets();
  const close = useRef<HTMLButtonElement>(null);
  const [error, setError] = useState("");
  const title = stripCf(row.title ?? "") || "New conversation";

  useEffect(() => {
    close.current?.focus();
    data.loadConversation(row.id).catch(() => {}); // the agents may have come and gone since the page loaded
  }, [row.id]);

  const run = async (act: () => Promise<void>) => {
    setError("");
    try {
      await act();
    } catch (err) {
      const text = humanError(err);
      if (text) setError(text);
    }
  };

  /** Removing is at once; the toast offers Undo, which puts the agent back with what it saw before (its closed asks stay closed). */
  const remove = async (iid: number, handle: string) => {
    await removeAgent(row.id, iid);
    toast(`Removed @${handle}`, () => addAgent(row.id, iid, "full").catch((err) => fail(humanError(err))));
  };

  return (
    <>
    <div className="detscrim" aria-hidden="true" onClick={onClose} />
    <aside className="details" aria-label={`Details for ${title}`} onKeyDown={(event) => event.key === "Escape" && onClose()}>
      <div className="detgrab" aria-hidden="true" />
      <header className="detailsbar">
        <div className="titles">
          <h2>Details</h2>
          <span className="text-13 text-muted">{title}</span>
        </div>
        <IconButton ref={close} label="Close details" onClick={onClose}>
          <span aria-hidden="true" className="text-[26px] leading-none text-muted">×</span>
        </IconButton>
      </header>
      <div className="detailsbody">
        {error ? <p role="alert">{error}</p> : null}
        <WaitingSection row={row} decide={(iid, approve) => void run(() => decideAdd(row.id, iid, approve))} />
        <AgentsSection
          row={row}
          board={board}
          act={act}
          onAdd={() => open((done) => <AddAgentSheet id={row.id} done={done} onInvite={onInvite} onAdd={(who, handle) => addAgent(row.id, who).then(() => toast(`${handle} joined ${title}`))} />)}
          onRemove={(iid, handle) => void run(() => remove(iid, handle))}
        />

        <PinnedList row={row} />

        <section aria-labelledby="det-conv" className="detsec">
          <div className="dethead">
            <h3 id="det-conv">Conversation</h3>
          </div>
          <dl className="convrows">
            <Row label="You" value={row.participants.filter((p) => p.kind !== "agent").map(personName).join(", ")} />
            <Row label="Started by" value={row.started_by ? personName(row.started_by) : ""} />
            <Row label="Created" value={fmtDate(row.created_at)} />
            <Row label="Muted" value={row.muted_until ? `Until ${fmtDate(row.muted_until)}` : "No"} />
            <Row label="Pull request" value={row.link_url ? <a href={row.link_url} target="_blank" rel="noopener noreferrer">{row.link_url}</a> : "None"} />
          </dl>
        </section>

        <section aria-label="Actions" className="detsec actions-sec">
          <Button onClick={() => void markAllRead(row.id).catch((err) => fail(humanError(err)))}>
            Mark all read
          </Button>
          <Button onClick={() => void run(() => setMute(row.id, !row.muted_until))}>
            {row.muted_until ? "Unmute" : "Mute"}
          </Button>
          <Button onClick={() => open((done) => <RenameSheet current={row.title ?? ""} done={done} onSave={(t) => rename(row.id, t)} />)}>
            Rename
          </Button>
          <Button variant="danger" onClick={() => open((done) => <DeleteSheet id={row.id} done={done} />)}>
            Delete conversation
          </Button>
        </section>
      </div>
      {sheet}
    </aside>
    </>
  );
}

function DeleteSheet({ id, done }: { id: number; done(): void }) {
  const [alert, setAlert] = useState("");
  return (
    <Sheet
      title="Delete conversation"
      alert={alert}
      onClose={done}
      actions={
        <>
          <Button
            variant="danger"
            onClick={() =>
              deleteConversation(id).then(
                () => location.assign("/chats"),
                (err) => setAlert(humanError(err)),
              )
            }
          >
            Delete conversation
          </Button>
          <CancelButton onClick={done} />
        </>
      }
    >
      <p className="text-muted">It moves to Trash and is deleted forever in 30 days. You can restore it until then.</p>
    </Sheet>
  );
}

function personName(p: Person): string {
  return p.kind === "agent" ? `@${p.handle}` : p.display_name || p.handle;
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="convrow">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function RenameSheet({ current, done, onSave }: { current: string; done(): void; onSave(title: string): Promise<void> }) {
  const [text, setText] = useState(current);
  const [alert, setAlert] = useState("");
  const save = () => onSave(text.trim()).then(done, (err) => setAlert(humanError(err)));
  return (
    <Sheet
      title="Rename conversation"
      alert={alert}
      onClose={done}
      actions={
        <>
          <Button variant="primary" disabled={!text.trim()} onClick={() => void save()}>
            Save
          </Button>
          <CancelButton onClick={done} />
        </>
      }
    >
      <Field label="Title" value={text} maxLength={120} onChange={(event) => setText(event.target.value)} />
    </Sheet>
  );
}
