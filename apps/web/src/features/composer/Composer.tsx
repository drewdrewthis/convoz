import { IconButton } from "@convoz/ui/IconButton";
import type { Identity, Upload } from "@convoz/api-client";
import { mentionsOf } from "@convoz/markdown";
import { AttachIcon, MicIcon, SendIcon } from "@convoz/ui/icons";
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { useVoiceNote } from "../voice/index.ts";
import { AttachmentList } from "./AttachmentList.tsx";
import { loadDraft, saveDraft } from "./draft.ts";
import { pasteFiles, type Attachments } from "./attachments.ts";
import { enterSends } from "./enterToSend.ts";
import { keepFocus } from "./keepFocus.ts";
import { MentionMenu, useMentionMenu } from "./MentionMenu.tsx";

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
  const [text, setText] = useState(() => loadDraft(location.pathname));
  const picker = useRef<HTMLInputElement>(null);
  const voice = useVoiceNote(conversationId, (sent) => onSend("", [sent]));
  const files = attachments.items;
  const empty = text.trim() === "" && files.length === 0;
  // A crew agent typed by hand (outside code and quotes) counts like a pick: the server brings it in when the message arrives (I-18).
  const named = Boolean(mentions) && mentionsOf(text).some((h) => mentions!.crew.some((p) => p.handle === h));
  const canSend = (Boolean(agent) || named) && !empty && files.every((f) => f.state === "done" || f.state === "held");

  // Every change is kept at once: an update can reload the page at any moment (sw/index.ts), and the box is filled again from it.
  useEffect(() => saveDraft(location.pathname, text), [text]);

  useLayoutEffect(() => {
    const box = textRef.current;
    if (!box) return;
    box.style.height = "auto";
    // An empty box keeps its one line: scrollHeight would count the wrapped placeholder. The CSS max-height stops the growth at four
    // lines on a phone (six on a wide screen) and the box scrolls inside itself from there.
    box.style.height = text === "" ? "" : `${box.scrollHeight}px`;
  }, [text, textRef]);

  const mention = useMentionMenu({ text, setText, crew: mentions?.crew, focus: () => textRef.current?.focus(), onPick: mentions?.onPick, onInvite: mentions?.onInvite });
  const change = (value: string) => {
    setText(value);
    voice.clearNote();
    mention.changed(value);
  };

  const keyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (mention.keyDown(event)) return;
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && enterSends()) {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }
  };

  return (
    <div className="compose">
      {mentions ? <MentionMenu mention={mention} crew={mentions.crew} invites={Boolean(mentions.onInvite)} /> : null}
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
          saveDraft(location.pathname, ""); // now: the first send of a new conversation moves the page to its URL before the effect runs
          attachments.clear();
          textRef.current?.focus(); // the keyboard stays up
          onSend(body, sent, held);
        }}
      >
        <IconButton variant="muted" glyph={18} stroke={2} label="Attach a file" onMouseDown={keepFocus} onClick={() => picker.current?.click()}>
          <AttachIcon />
        </IconButton>
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
          <IconButton id="send" type="submit" variant="send" glyph={18} stroke={2} className={empty ? "opacity-0 pointer-events-none" : undefined} label="Send" disabled={!canSend} onMouseDown={keepFocus}>
            <SendIcon />
          </IconButton>
          <IconButton ref={voice.mic} variant="soft" glyph={18} stroke={2} className="absolute inset-0" label="Record a voice message" hidden={!empty} disabled={!conversationId} onMouseDown={keepFocus} onClick={voice.start}>
            <MicIcon />
          </IconButton>
        </span>
      </form>
      {voice.note}
    </div>
  );
}
