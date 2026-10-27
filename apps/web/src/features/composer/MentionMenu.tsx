import { Button } from "@convoz/ui/Button";
import { EmptyState } from "@convoz/ui/EmptyState";
import type { Identity } from "@convoz/api-client";
import { useEffect, useRef, useState, type Dispatch, type KeyboardEvent, type SetStateAction } from "react";
import { initials, paletteOf, stripCf } from "../../shared/chat.ts";
import { TriageBadge } from "../../shared/TriageBadge.tsx";
import { fuzzyMatch } from "./fuzzyMatch.ts";
import { keepFocus } from "./keepFocus.ts";

/** The open "@" menu: the agents whose handle or name matches what follows the "@", closest first, and the highlighted row. */
export interface MentionMenuState {
  shown: Identity[];
  active: number;
}

export interface MentionMenuOptions {
  /** The box's text, owned by the caller. */
  text: string;
  setText: Dispatch<SetStateAction<string>>;
  /** The agents "@" lists; with none given the menu never opens. */
  crew: Identity[] | undefined;
  /** Puts the focus back in the box after a pick. */
  focus(): void;
  onPick?(who: Identity): void;
  /** With it, "Invite a new agent…" ends the list. */
  onInvite?(): void;
}

export interface MentionMenuControl {
  menu: MentionMenuState | null;
  /** Call with each new value of the box: it opens, narrows or closes the menu. */
  changed(value: string): void;
  /** Arrows, Enter and Escape while the menu is open; true when the key was the menu's. */
  keyDown(event: KeyboardEvent<HTMLElement>): boolean;
  pick(who: Identity): void;
  invite(): void;
}

const AT_END = /(^|\s)@[a-z0-9-]*$/;

/**
 * useMentionMenu is the "@" menu of a message box (the main composer and the thread's reply box): typing "@" lists the crew, and a
 * pick writes "@handle " in place of what was typed after the "@".
 */
export function useMentionMenu({ text, setText, crew, focus, onPick, onInvite }: MentionMenuOptions): MentionMenuControl {
  const [menu, setMenu] = useState<MentionMenuState | null>(null);

  const menuFor = (value: string, agents: Identity[]) => {
    const m = /(?:^|\s)@([a-z0-9-]*)$/.exec(value);
    const shown = m ? fuzzyMatch(agents, m[1]!) : [];
    // "Invite a new agent…" ends the list whenever the box is on an "@", so a handle nobody has yet still leads somewhere.
    return shown.length || (m && onInvite) ? { shown, active: 0 } : null;
  };

  // An "@" typed before the crew has loaded opens the menu once it arrives.
  // The effect reads the latest values through a ref so it runs only on the crew's arrival, not on every keystroke.
  const latest = useRef({ text, crew, menuFor });
  latest.current = { text, crew, menuFor };
  // On load as well as on a new count: an empty crew still opens the menu on "Invite a new agent…".
  const crewLoaded = crew !== undefined;
  const crewCount = crew?.length ?? 0;
  useEffect(() => {
    const { text: now, crew: agents, menuFor: open } = latest.current;
    if (agents) setMenu((shown) => shown ?? open(now, agents));
  }, [crewLoaded, crewCount]);

  const invite = () => {
    setMenu(null);
    setText((now) => now.replace(AT_END, "$1"));
    onInvite!();
  };

  const pick = (who: Identity) => {
    setMenu(null);
    setText((now) => now.replace(AT_END, `$1@${who.handle} `));
    focus();
    onPick?.(who);
  };

  const keyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (!menu) return false;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const n = menu.shown.length + (onInvite ? 1 : 0);
      setMenu({ ...menu, active: (menu.active + (event.key === "ArrowDown" ? 1 : -1) + n) % n });
      return true;
    }
    if (event.key === "Enter" && !event.nativeEvent.isComposing) {
      event.preventDefault();
      if (menu.active >= menu.shown.length) invite();
      else pick(menu.shown[menu.active]!);
      return true;
    }
    if (event.key === "Escape") {
      setMenu(null);
      return true;
    }
    return false;
  };

  const changed = (value: string) => {
    if (crew) setMenu(menuFor(value, crew));
  };
  return { menu, changed, keyDown, pick, invite };
}

export interface MentionMenuProps {
  mention: MentionMenuControl;
  crew: Identity[];
  /** Shows "Invite a new agent…" at the end of the list. */
  invites: boolean;
  /** Prefixes the element ids, so a second menu on the page does not repeat the main composer's. */
  idPrefix?: string;
}

/** MentionMenu is the "Agents" list the "@" menu shows above its box. */
export function MentionMenu({ mention, crew, invites, idPrefix = "" }: MentionMenuProps) {
  const { menu, pick, invite } = mention;
  return (
    <div id={`${idPrefix}picker`} className="pop" hidden={!menu}>
      <ul id={`${idPrefix}agents`} className="agents" role="list" aria-label="Agents">
        {(menu?.shown ?? []).map((who, i) => (
          <li key={who.handle} role="presentation">
            <Button variant="text" className="agentbtn" tabIndex={-1} aria-selected={i === menu!.active} onClick={() => pick(who)} onMouseDown={keepFocus}>
              <span className={`ava p${paletteOf(who.handle)}`} aria-hidden="true" data-l={initials(who.handle)} />
              <span className="who">
                <span className="handle" aria-label={`@${who.handle}`}>
                  {who.handle}
                </span>
                <span className="name">{stripCf(who.display_name)}</span>
              </span>{" "}
              <TriageBadge handle={who.handle} />{" "}
              <span className={`state${who.online ? " on" : ""}`}>
                <i aria-hidden="true" />
                <span>{who.online ? "Online" : "Offline"}</span>
              </span>
            </Button>
          </li>
        ))}
      </ul>
      {invites ? (
        <Button variant="text" className="agentbtn invite" role="option" tabIndex={-1} aria-selected={menu ? menu.active >= menu.shown.length : false} hidden={!menu} onClick={invite} onMouseDown={keepFocus}>
          Invite a new agent…
        </Button>
      ) : null}
      <EmptyState id={`${idPrefix}picker-note`} variant="compact" hidden={crew.length > 0}>
        No agents yet. Connect a machine and add an agent first.
      </EmptyState>
    </div>
  );
}
