import type { Identity, Upload } from "@convoz/api-client";
import { AttachIcon, CloseIcon, FileIcon, MicIcon, SendIcon } from "@convoz/ui/icons";
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { initials, paletteOf, stripCf } from "../../shared/chat.ts";
import { fileSize } from "../../shared/uploads.ts";
import { loadRecorder, type VoiceRecording } from "../voice/index.ts";
import type { Attachments } from "./attachments.ts";
import { enterSends } from "./enterToSend.ts";

export interface ComposerProps {
  /** The agent the message goes to; with none, Send stays disabled. */
  agent: string | null;
  /** The message box's accessible name: "Message @agent", or "Message" with several agents or none yet. */
  label: string;
  /** The conversation files upload to; 0 for a new one, where Attach and the microphone are disabled. */
  conversationId: number;
  /** The files to send, owned by the page (a drop on the conversation adds to them). */
  attachments: Attachments;
  /** The body (may be empty when there are files) and the finished uploads. */
  onSend(body: string, files: Upload[]): void;
  /** The text box, for the page to focus. */
  textRef: RefObject<HTMLTextAreaElement | null>;
  /**
   * Typing "@" lists these agents above the box. With `onPick` (New conversation) picking one starts the chat with it; without it
   * (a conversation that exists) picking one writes its handle into the message, and sending the message brings the agent in (I-18).
   */
  mentions?: { crew: Identity[]; onPick?(who: Identity): void; onInvite?(): void };
}

type Recorder = Awaited<ReturnType<typeof loadRecorder>>;

/**
 * Composer is the pinned message box: it grows to about six lines, then scrolls inside itself. Attach adds files above it; the
 * microphone (in Send's place while there is nothing to send) swaps the box for the recording bar.
 */
export function Composer({ agent, label, conversationId, attachments, onSend, textRef, mentions }: ComposerProps) {
  const [text, setText] = useState("");
  const [menu, setMenu] = useState<{ shown: Identity[]; active: number } | null>(null);
  const [voice, setVoice] = useState<{ Bar: Recorder["RecordingBar"]; recording: VoiceRecording } | null>(null);
  const [micError, setMicError] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const mic = useRef<HTMLButtonElement>(null);
  const files = attachments.items;
  const empty = text.trim() === "" && files.length === 0;
  const canSend = Boolean(agent) && !empty && files.every((f) => f.state === "done");

  const starting = useRef(false);
  const startVoice = async () => {
    if (starting.current) return; // a second tap while the microphone prompt is open
    starting.current = true;
    setMicError(false);
    try {
      const recorder = await loadRecorder(); // the recorder's code loads on the first tap
      setVoice({ Bar: recorder.RecordingBar, recording: await recorder.startRecording(conversationId) });
    } catch {
      setMicError(true);
    } finally {
      starting.current = false;
    }
  };
  const endVoice = (sent?: Upload) => {
    setVoice(null);
    if (sent) onSend("", [sent]);
    requestAnimationFrame(() => mic.current?.focus());
  };

  useLayoutEffect(() => {
    const box = textRef.current;
    if (!box) return;
    box.style.height = "auto";
    // An empty box keeps its one line: scrollHeight would count the wrapped placeholder.
    box.style.height = text === "" ? "" : `${Math.min(box.scrollHeight, 180)}px`;
  }, [text, textRef]);

  const menuFor = (value: string, crew: Identity[]) => {
    const m = /(?:^|\s)@([a-z0-9-]*)$/.exec(value);
    const shown = m ? crew.filter((p) => p.handle.startsWith(m[1]!)) : [];
    // "Invite a new agent…" ends the list whenever the box is on an "@", so a handle nobody has yet still leads somewhere.
    return shown.length || (m && mentions?.onInvite) ? { shown, active: 0 } : null;
  };
  const change = (value: string) => {
    setText(value);
    setMicError(false);
    if (mentions) setMenu(menuFor(value, mentions.crew));
  };

  // An "@" typed before the crew has loaded opens the menu once it arrives.
  const crewCount = mentions?.crew.length ?? 0;
  useEffect(() => {
    if (crewCount && mentions) setMenu((open) => open ?? menuFor(text, mentions.crew));
  }, [crewCount]); // only on the crew's arrival, not on every keystroke

  const invite = () => {
    setMenu(null);
    setText((now) => now.replace(/(^|\s)@[a-z0-9-]*$/, "$1"));
    mentions!.onInvite!();
  };

  const pick = (who: Identity) => {
    setMenu(null);
    if (!mentions!.onPick) {
      setText((now) => now.replace(/(^|\s)@[a-z0-9-]*$/, `$1@${who.handle} `));
      textRef.current?.focus();
      return;
    }
    setText("");
    mentions!.onPick(who);
  };

  const keyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (menu) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const n = menu.shown.length + (mentions?.onInvite ? 1 : 0);
        setMenu({ ...menu, active: (menu.active + (event.key === "ArrowDown" ? 1 : -1) + n) % n });
        return;
      }
      if (event.key === "Enter" && !event.nativeEvent.isComposing) {
        event.preventDefault();
        if (menu.active >= menu.shown.length) invite();
        else pick(menu.shown[menu.active]!);
        return;
      }
      if (event.key === "Escape") {
        setMenu(null);
        return;
      }
    }
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && enterSends()) {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }
  };

  return (
    <div className="compose">
      {mentions ? (
        <div id="picker" className="pop" hidden={!menu}>
          <ul id="agents" className="agents" role="list" aria-label="Agents">
            {(menu?.shown ?? []).map((who, i) => (
              <li key={who.handle} role="presentation">
                <button className="agentbtn" type="button" tabIndex={-1} aria-selected={i === menu!.active} onClick={() => pick(who)} onMouseDown={(e) => e.preventDefault()}>
                  <span className={`ava p${paletteOf(who.handle)}`} aria-hidden="true" data-l={initials(who.handle)} />
                  <span className="who">
                    <span className="handle" aria-label={`@${who.handle}`}>
                      {who.handle}
                    </span>
                    <span className="name">{stripCf(who.display_name)}</span>
                  </span>{" "}
                  <span className={`state${who.online ? " on" : ""}`}>
                    <i aria-hidden="true" />
                    <span>{who.online ? "Online" : "Offline"}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {mentions.onInvite ? (
            <button className="agentbtn invite" type="button" role="option" tabIndex={-1} aria-selected={menu ? menu.active >= menu.shown.length : false} hidden={!menu} onClick={invite} onMouseDown={(e) => e.preventDefault()}>
              Invite a new agent…
            </button>
          ) : null}
          <p id="picker-note" className="empty" hidden={mentions.crew.length > 0}>
            No agents yet. Connect a machine and add an agent first.
          </p>
        </div>
      ) : null}
      {files.length ? (
        <div role="list" aria-label="Files to send" className="tosend">
          {files.map((f) => (
            <span key={f.key} role="listitem" className={`fin${f.state === "failed" ? " bad" : ""}`}>
              <span className="fic" aria-hidden="true">
                <FileIcon />
              </span>
              <span className="fname">{f.file.name}</span>
              <span className="fsize">{fileSize(f.file.size)}</span>
              {f.state === "uploading" ? <Progress name={f.file.name} pct={f.file.size ? Math.round((f.sent / f.file.size) * 100) : 0} /> : null}
              {f.state === "failed" ? (
                <>
                  <span className="fbad">Upload failed</span>
                  <button type="button" className="fretry" onClick={() => attachments.retry(f.key)}>
                    Retry
                  </button>
                </>
              ) : null}
              <button type="button" className="fx" aria-label={`Remove ${f.file.name}`} title="Remove" onClick={() => attachments.remove(f.key)}>
                <CloseIcon />
              </button>
            </span>
          ))}
        </div>
      ) : null}
      {attachments.note ? (
        <p role="status" className="fnote">
          {attachments.note}
        </p>
      ) : null}
      {voice ? <voice.Bar recording={voice.recording} onDone={endVoice} /> : null}
      <form
        hidden={Boolean(voice)}
        id="composer"
        className="composer glass"
        aria-label="Composer"
        autoComplete="off"
        onSubmit={(event) => {
          event.preventDefault();
          const body = text.trim();
          if (!canSend) return;
          const sent = files.map((f) => f.upload!);
          setText("");
          attachments.clear();
          textRef.current?.focus(); // the keyboard stays up
          onSend(body, sent);
        }}
      >
        <button type="button" className="attachbtn" aria-label="Attach a file" title="Attach a file" disabled={!conversationId} onClick={() => picker.current?.click()}>
          <AttachIcon />
        </button>
        <input
          ref={picker}
          type="file"
          multiple
          aria-label="Attach files"
          hidden
          onChange={(e) => {
            attachments.add(Array.from(e.target.files ?? []));
            e.target.value = ""; // the same file can be chosen again
          }}
        />
        <textarea
          ref={textRef}
          id="text"
          rows={1}
          enterKeyHint="send"
          autoCapitalize="sentences"
          aria-label={label}
          placeholder="Message the conversation. Type @ to add an agent."
          value={text}
          onChange={(e) => change(e.target.value)}
          onKeyDown={keyDown}
        />
        <span className="sendslot">
          {/* Send stays in the page (and disabled) under the microphone while there is nothing to send. */}
          <button id="send" className={`sendbtn${empty ? " under" : ""}`} type="submit" aria-label="Send" disabled={!canSend}>
            <SendIcon />
          </button>
          <button ref={mic} type="button" className="sendbtn mic" aria-label="Record a voice message" title="Record a voice message" hidden={!empty} disabled={!conversationId} onClick={() => void startVoice()}>
            <MicIcon />
          </button>
        </span>
      </form>
      {micError ? (
        <p role="alert" className="micnote">
          The microphone is not available.
        </p>
      ) : null}
    </div>
  );
}

function Progress({ name, pct }: { name: string; pct: number }) {
  return (
    <span className="fbar" role="progressbar" aria-label={`Uploading ${name}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
      <i style={{ width: `${pct}%` }} />
    </span>
  );
}
