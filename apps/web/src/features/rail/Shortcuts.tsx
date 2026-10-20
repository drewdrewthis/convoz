import { Sheet } from "@convoz/ui/Sheet";
import { useEffect } from "react";
import { create } from "zustand";
import { Button } from "@convoz/ui/Button";
import { useFold } from "./fold.ts";

/** Every key the app answers to, for the "Keyboard shortcuts" dialog. Keep it equal to what the handlers below and the pages do. */
export const SHORTCUTS: readonly { keys: string; does: string }[] = [
  { keys: "Cmd+K", does: "Search from anywhere" },
  { keys: "Cmd+J", does: "Start a new conversation" },
  { keys: "Cmd+[", does: "Back to the conversation you came from" },
  { keys: "Cmd+]", does: "Forward again" },
  { keys: "Cmd+\\", does: "Fold or unfold the sidebar" },
  { keys: "Alt+ArrowUp", does: "Move the conversation in focus up the rail" },
  { keys: "Alt+ArrowDown", does: "Move the conversation in focus down the rail" },
  { keys: "I", does: "Show or hide the details of a conversation" },
  { keys: "?", does: "Show this list" },
  { keys: "Escape", does: "Close a dialog, the search or the details" },
];

const useHelp = create<{ open: boolean; set(open: boolean): void }>()((set) => ({ open: false, set: (open) => set({ open }) }));

const typing = (el: EventTarget | null) => el instanceof HTMLElement && Boolean(el.closest("input, textarea, select, [contenteditable=''], [contenteditable='true']"));

/**
 * useRailShortcuts handles the keys that belong to no page: Cmd+[ and Cmd+] move through the conversations visited (a page is a
 * full load, so this is the browser's own history), Cmd+\ folds the sidebar, and "?" opens the list of keys, unless the person is typing.
 */
export function useRailShortcuts(): void {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const cmd = event.metaKey || event.ctrlKey;
      if (cmd && !event.altKey && !event.shiftKey && (event.key === "[" || event.key === "]")) {
        event.preventDefault();
        if (event.key === "[") history.back();
        else history.forward();
      } else if (cmd && !event.altKey && !event.shiftKey && event.key === "\\") {
        event.preventDefault();
        useFold.getState().toggle();
      } else if (event.key === "?" && !cmd && !event.altKey && !typing(event.target) && !document.querySelector("dialog[open]")) {
        event.preventDefault();
        useHelp.getState().set(true);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
}

/** ShortcutsHost draws the dialog while it is open. Escape closes it and the focus goes back where it was. */
export function ShortcutsHost() {
  const open = useHelp((s) => s.open);
  const set = useHelp((s) => s.set);
  if (!open) return null;
  return (
    <Sheet
      title="Keyboard shortcuts"
      onClose={() => set(false)}
      actions={
        <Button variant="quiet" onClick={() => set(false)}>
          Close
        </Button>
      }
    >
      <p className="text-muted">Cmd is Ctrl on Windows and Linux.</p>
      <dl className="keys">
        {SHORTCUTS.map((s) => (
          <div key={s.keys} className="keyrow">
            <dt>
              <kbd>{s.keys}</kbd>
            </dt>
            <dd>{s.does}</dd>
          </div>
        ))}
      </dl>
    </Sheet>
  );
}
