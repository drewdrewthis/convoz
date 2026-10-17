import { SearchIcon } from "@convoz/ui/icons";
import { lazy, Suspense, useEffect } from "react";
import { useSearchUi } from "./store.ts";

// The overlay is a chunk of its own: the shell pays for the button, and the rest when the owner opens search.
const Overlay = lazy(() => import("./Overlay.tsx"));

/** SearchButton is the top bar's Search button (the prototype has it where the phone's top bar ends). */
export function SearchButton() {
  const open = useSearchUi((s) => s.open);
  const show = useSearchUi((s) => s.show);
  return (
    <button type="button" className="iconbtn searchbtn" aria-label="Search" aria-haspopup="dialog" aria-expanded={open} aria-keyshortcuts="Control+K Meta+K" title="Search · ⌘K" onClick={(e) => show(e.currentTarget)}>
      <SearchIcon />
    </button>
  );
}

/** SearchHost draws the overlay while it is open. */
export function SearchHost() {
  const open = useSearchUi((s) => s.open);
  return open ? (
    <Suspense fallback={null}>
      <Overlay />
    </Suspense>
  ) : null;
}

/** useSearchShortcut opens search on Ctrl+K or Cmd+K, from anywhere on the page. */
export function useSearchShortcut(): void {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "k") {
        event.preventDefault();
        const ui = useSearchUi.getState();
        if (ui.open) ui.hide();
        else ui.show(document.activeElement instanceof HTMLElement ? document.activeElement : null);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
}
