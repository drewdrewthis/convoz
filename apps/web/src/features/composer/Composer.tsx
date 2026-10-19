import type { Identity, Upload } from "@convoz/api-client";
import { mentionsOf } from "@convoz/markdown";
import { AttachIcon, MicIcon, SendIcon } from "@convoz/ui/icons";
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { initials, paletteOf, stripCf } from "../../shared/chat.ts";
import { useVoiceNote } from "../voice/index.ts";
import { AttachmentList } from "./AttachmentList.tsx";
import { pasteFiles, type Attachments } from "./attachments.ts";
import { enterSends } from "./enterToSend.ts";
import { keepFocus } from "./keepFocus.ts";

export interface ComposerProps {
  /** The agent the message goes to; with none (and none typed as an @mention), Send stays disabled. */
  agent: string | null;
  /** The message box's accessible name: "Message @agent", or "Message" with several agents or none yet. */
  label: string;
  /** The conversation files upload to; 0 for a new one, where files are held until the first send makes it and the microphone is disabled. */
  conversationId: number;
  /** The files to send, owned by the page (a drop on the conversation adds to them). */
  attachments: Attachments;
  /** The body (may be empty when there are files), the finished uploads, and the files held for a new conversation (not uploaded yet). */
  onSend(body: string, files: Upload[], held?: File[]): void;
  /** The text box, for the page to focus. */
  textRef: RefObject<HTMLTextAreaElement | null>;
  /**
   * Typing "@" lists these agents above the box. Picking one writes its handle into the message, and sending the message brings the
   * agent in (I-18), in a new conversation as in one that exists. `onPick` only tells the page who was picked.
   */
  mentions?: { crew: Identity[]; onPick?(who: Identity): void; onInvite?(): void };
}

/**
 * Composer is the pinned message box: it grows to four lines on a phone (six on a wide screen), then scrolls inside itself. Attach adds files above it; the
 * microphone (in Send's place while there is nothing to send) swaps the box for the recording bar.
 */
export function Composer({ agent, label, conversationId, attachments, onSend, textRef, mentions }: ComposerProps) {
  const [text, setText] = useState("");
  const [menu, setMenu] = useState<{ shown: Identity[]; active: number } | null>(null);
  const picker = useRef<HTMLInputElement>(null);
  const voice = useVoiceNote(conversationId, (sent) => onSend("", [sent]));
  const files = attachments.items;
  const empty = text.trim() === "" && files.length === 0;
  // A crew agent typed by hand (outside code and quotes) counts like a pick: the server brings it in when the message arrives (I-18).
  const named = Boolean(mentions) && mentionsOf(text).some((h) => mentions!.crew.some((p) => p.handle === h));
  const canSend = (Boolean(agent) || named) && !empty && files.every((f) => f.state === "done" || f.state === "held");

  useLayoutEffect(() => {
    const box = textRef.current;
    if (!box) return;
    box.style.height = "auto";
    // An empty box keeps its one line: scrollHeight would count the wrapped placeholder. The CSS max-height stops the growth at four
    // lines on a phone (six on a wide screen) and the box scrolls inside itself from there.
    box.style.height = text === "" ? "" : `${box.scrollHeight}px`;
  }, [text, textRef]);

  const menuFor = (value: string, crew: Identity[]) => {
    const m = /(?:^|\s)@([a-z0-9-]*)$/.exec(value);
    const shown = m ? crew.filter((p) => p.handle.startsWith(m[1]!)) : [];
    // "Invite a new agent…" ends the list whenever the box is on an "@", so a handle nobody has yet still leads somewhere.
    return shown.length || (m && mentions?.onInvite) ? { shown, active: 0 } : null;
  };
  const change = (value: string) => {
    setText(value);
    voice.clearNote();
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
    setText((now) => now.replace(/(^|\s)@[a-z0-9-]*$/, `$1@${who.handle} `));
    textRef.current?.focus();
    mentions!.onPick?.(who);
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
                <button className="agentbtn" type="button" tabIndex={-1} aria-selected={i === menu!.active} onClick={() => pick(who)} onMouseDown={keepFocus}>
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
            <button className="agentbtn invite" type="button" role="option" tabIndex={-1} aria-selected={menu ? menu.active >= menu.shown.length : false} hidden={!menu} onClick={invite} onMouseDown={keepFocus}>
              Invite a new agent…
            </button>
          ) : null}
          <p id="picker-note" className="empty" hidden={mentions.crew.length > 0}>
            No agents yet. Connect a machine and add an agent first.
          </p>
        </div>
      ) : null}
      <AttachmentList attachments={attachments} />
      {voice.bar}
      <form
        hidden={voice.recording}
        id="composer"
        className="composer glass"
        aria-label="Composer"
        autoComplete="off"
        onSubmit={(event) => {
          event.preventDefault();
          const body = text.trim();
          if (!canSend) return;
          const sent = files.filter((f) => f.upload).map((f) => f.upload!);
          const held = files.filter((f) => f.state === "held").map((f) => f.file);
          setText("");
          attachments.clear();
          textRef.current?.focus(); // the keyboard stays up
          onSend(body, sent, held);
        }}
      >
        <button type="button" className="attachbtn" aria-label="Attach a file" title="Attach a file" onMouseDown={keepFocus} onClick={() => picker.current?.click()}>
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
          enterKeyHint={enterSends() ? "send" : "enter"}
          autoCapitalize="sentences"
          autoCorrect="on"
          spellCheck
          aria-label={label}
          placeholder="Message the conversation. Type @ to add an agent."
          value={text}
          onChange={(e) => change(e.target.value)}
          onKeyDown={keyDown}
          onPaste={(e) => pasteFiles(e, attachments)}
        />
        <span className="sendslot">
          {/* Send stays in the page (and disabled) under the microphone while there is nothing to send. */}
          <button id="send" className={`sendbtn${empty ? " under" : ""}`} type="submit" aria-label="Send" disabled={!canSend} onMouseDown={keepFocus}>
            <SendIcon />
          </button>
          <button ref={voice.mic} type="button" className="sendbtn mic" aria-label="Record a voice message" title="Record a voice message" hidden={!empty} disabled={!conversationId} onMouseDown={keepFocus} onClick={voice.start}>
            <MicIcon />
          </button>
        </span>
      </form>
      {voice.note}
    </div>
  );
}
