import type { Identity } from "@convoz/api-client";
import { SendIcon } from "@convoz/ui/icons";
import { useEffect, useLayoutEffect, useState, type KeyboardEvent, type RefObject } from "react";
import { initials, paletteOf, stripCf } from "../../shared/chat.ts";

// On a coarse pointer or a narrow screen Enter adds a line and only Send sends (read at each key: the screen can change).
const phone = matchMedia("(pointer: coarse), (max-width: 600px)");

export interface ComposerProps {
  /** The agent the message goes to; with none, Send stays disabled. */
  agent: string | null;
  /** The message box's accessible name: "Message @agent", or "Message" with several agents or none yet. */
  label: string;
  onSend(body: string): void;
  /** The text box, for the page to focus. */
  textRef: RefObject<HTMLTextAreaElement | null>;
  /** New conversation: typing "@" lists these agents above the box; picking one starts the chat with it. */
  mentions?: { crew: Identity[]; onPick(who: Identity): void };
}

/** Composer is the pinned message box: it grows to about six lines, then scrolls inside itself. */
export function Composer({ agent, label, onSend, textRef, mentions }: ComposerProps) {
  const [text, setText] = useState("");
  const [menu, setMenu] = useState<{ shown: Identity[]; active: number } | null>(null);

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
    return shown.length ? { shown, active: 0 } : null;
  };
  const change = (value: string) => {
    setText(value);
    if (mentions) setMenu(menuFor(value, mentions.crew));
  };

  // An "@" typed before the crew has loaded opens the menu once it arrives.
  const crewCount = mentions?.crew.length ?? 0;
  useEffect(() => {
    if (crewCount && mentions) setMenu((open) => open ?? menuFor(text, mentions.crew));
  }, [crewCount]); // only on the crew's arrival, not on every keystroke

  const pick = (who: Identity) => {
    setText("");
    setMenu(null);
    mentions!.onPick(who);
  };

  const keyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (menu) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const n = menu.shown.length;
        setMenu({ ...menu, active: (menu.active + (event.key === "ArrowDown" ? 1 : -1) + n) % n });
        return;
      }
      if (event.key === "Enter" && !event.nativeEvent.isComposing) {
        event.preventDefault();
        pick(menu.shown[menu.active]!);
        return;
      }
      if (event.key === "Escape") {
        setMenu(null);
        return;
      }
    }
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && !phone.matches) {
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
          <p id="picker-note" className="empty" hidden={mentions.crew.length > 0}>
            No agents yet. Connect a machine and add an agent first.
          </p>
        </div>
      ) : null}
      <form
        id="composer"
        className="composer glass"
        aria-label="Composer"
        autoComplete="off"
        onSubmit={(event) => {
          event.preventDefault();
          const body = text.trim();
          if (!body || !agent) return;
          setText("");
          textRef.current?.focus(); // the keyboard stays up
          onSend(body);
        }}
      >
        <span className="slot" aria-hidden="true" />
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
        <button id="send" className="sendbtn" type="submit" aria-label="Send" disabled={text.trim() === "" || !agent}>
          <SendIcon />
        </button>
      </form>
    </div>
  );
}
