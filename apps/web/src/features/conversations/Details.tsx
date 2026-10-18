import type { Conversation, Person } from "@convoz/api-client";
import { Field } from "@convoz/ui/Field";
import { Sheet } from "@convoz/ui/Sheet";
import { useEffect, useRef, useState } from "react";
import { humanError } from "../../shared/api.ts";
import { fmtDate } from "../../shared/api.ts";
import { initials, paletteOf, stripCf } from "../../shared/chat.ts";
import { data } from "../../shared/data.ts";
import { useNotice } from "../../shared/notice.tsx";
import { useSheets, CancelButton } from "../../shared/sheets.tsx";
import { PinnedList, toast } from "../pins-stars/index.ts";
import { setMute } from "../rail/index.ts";
import { AddAgentSheet } from "./AddAgentSheet.tsx";
import { addAgent, decideAdd, deleteConversation, markAllRead, removeAgent, rename } from "./actions.ts";

export interface DetailsProps {
  row: Conversation;
  onClose(): void;
}

/**
 * Details is the panel "Details for <title>" (prototype v41, key I): who is here, how the conversation is set, and what the owner
 * can do to it. On a phone it fills the screen; on a wide one it sits at the right edge.
 */
export function Details({ row, onClose }: DetailsProps) {
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

  const agents = row.participants.filter((p) => p.kind === "agent");
  return (
    <aside className="details" aria-label={`Details for ${title}`} onKeyDown={(event) => event.key === "Escape" && onClose()}>
      <header className="detailsbar">
        <div className="titles">
          <h2>Details</h2>
          <span className="sub">{title}</span>
        </div>
        <button ref={close} type="button" className="iconbtn" aria-label="Close details" onClick={onClose}>
          <span aria-hidden="true">×</span>
        </button>
      </header>
      <div className="detailsbody">
        {error ? <p role="alert">{error}</p> : null}
        <section aria-labelledby="det-parts" className="detsec">
          <div className="dethead">
            <h3 id="det-parts">Participants</h3>
            <button type="button" className="btn small quiet" onClick={() => open((done) => <AddAgentSheet id={row.id} done={done} onAdd={(who, handle) => addAgent(row.id, who).then(() => toast(`${handle} joined ${title}`))} />)}>
              + Add
            </button>
          </div>
          <ul aria-label="Participants" className="plist">
            {row.participants.map((p) => (
              <li key={p.handle} className="prow">
                <Who person={p} />
                {p.kind === "agent" && p.id ? (
                  <button type="button" className="btn small quiet" aria-label={`Remove @${p.handle}`} onClick={() => void run(() => remove(p.id!, p.handle))}>
                    Remove
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
          {agents.length === 0 ? <p className="muted">No agents yet.</p> : null}
          {row.pending?.length ? (
            <>
              <h4 className="detsub">Waiting for approval</h4>
              <ul aria-label="Waiting for approval" className="plist">
                {row.pending.map((add) => (
                  <li key={add.person.handle} className="prow">
                    <Who person={add.person} note={add.requested_by ? `asked by @${add.requested_by.handle}` : undefined} />
                    <button type="button" className="btn small quiet" aria-label={`Approve @${add.person.handle}`} onClick={() => void run(() => decideAdd(row.id, add.person.id!, true))}>
                      Approve
                    </button>
                    <button type="button" className="btn small quiet" aria-label={`Decline @${add.person.handle}`} onClick={() => void run(() => decideAdd(row.id, add.person.id!, false))}>
                      Decline
                    </button>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </section>

        <PinnedList row={row} />

        <section aria-labelledby="det-conv" className="detsec">
          <div className="dethead">
            <h3 id="det-conv">Conversation</h3>
          </div>
          <dl className="convrows">
            <Row label="Started by" value={row.started_by ? personName(row.started_by) : ""} />
            <Row label="Created" value={fmtDate(row.created_at)} />
            <Row label="Muted" value={row.muted_until ? `Until ${fmtDate(row.muted_until)}` : "No"} />
            <Row label="Pull request" value={row.link_url ? <a href={row.link_url} target="_blank" rel="noopener noreferrer">{row.link_url}</a> : "None"} />
          </dl>
        </section>

        <section aria-label="Actions" className="detsec actions-sec">
          <button type="button" className="btn" onClick={() => void markAllRead(row.id).catch((err) => fail(humanError(err)))}>
            Mark all read
          </button>
          <button type="button" className="btn" onClick={() => void run(() => setMute(row.id, !row.muted_until))}>
            {row.muted_until ? "Unmute" : "Mute"}
          </button>
          <button type="button" className="btn" onClick={() => open((done) => <RenameSheet current={row.title ?? ""} done={done} onSave={(t) => rename(row.id, t)} />)}>
            Rename
          </button>
          <button type="button" className="btn danger" onClick={() => open((done) => <DeleteSheet id={row.id} done={done} />)}>
            Delete conversation
          </button>
        </section>
      </div>
      {sheet}
    </aside>
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
          <button
            type="button"
            className="btn danger"
            onClick={() =>
              deleteConversation(id).then(
                () => location.assign("/chats"),
                (err) => setAlert(humanError(err)),
              )
            }
          >
            Delete conversation
          </button>
          <CancelButton onClick={done} />
        </>
      }
    >
      <p className="muted">It moves to Trash and is deleted forever in 30 days. You can restore it until then.</p>
    </Sheet>
  );
}

function personName(p: Person): string {
  return p.kind === "agent" ? `@${p.handle}` : p.display_name || p.handle;
}

function Who({ person, note }: { person: Person; note?: string }) {
  return (
    <span className="who">
      <span className={`ava p${paletteOf(person.handle)}`} aria-hidden="true" data-l={initials(person.handle)} />
      <span className="whotext">
        <span className="nm">{person.kind === "agent" ? `@${person.handle}` : person.display_name || person.handle}</span>
        <span className="sub">{note ?? (person.kind === "agent" ? person.display_name : "You")}</span>
      </span>
    </span>
  );
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
          <button type="button" className="btn primary" disabled={!text.trim()} onClick={() => void save()}>
            Save
          </button>
          <CancelButton onClick={done} />
        </>
      }
    >
      <Field label="Title" value={text} maxLength={120} onChange={(event) => setText(event.target.value)} />
    </Sheet>
  );
}
