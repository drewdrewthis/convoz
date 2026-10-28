import { IconButton } from "@convoz/ui/IconButton";
import { CloseIcon } from "@convoz/ui/icons";
import { useEffect, useRef } from "react";
import { openPanel, usePanel } from "./panel.ts";
import { PANELS, openedChat, pick } from "./registry.tsx";

/**
 * DrawerHost is the one right-side drawer of the signed-in app. The panel in the address (?panel=now) is what it shows; the page stays
 * in the middle. Wide screen: a column at the right edge, the page makes room (the body mark data-drawer). Phone: a full-height sheet
 * over the page. The close button and Escape close it. The Now page is the Now list itself, so it has no drawer.
 */
export function DrawerHost() {
  const panel = usePanel();
  const shown = panel && document.body.dataset.page !== "now" ? panel : null;
  const close = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    document.body.toggleAttribute("data-drawer", Boolean(shown));
    if (!shown) return;
    close.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      const t = e.target as Element;
      // Escape first closes what is open inside the drawer (a field, a card's menu); then it closes the drawer.
      if (t.closest?.("input, textarea, select, [contenteditable]") || document.querySelector("dialog[open]") || t.closest?.("[data-ask]")?.querySelector("[aria-haspopup][aria-expanded='true']")) return;
      openPanel(null);
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.removeAttribute("data-drawer");
    };
  }, [shown]);
  if (!shown) return null;
  const { title, Body } = PANELS[shown];
  return (
    <aside className="drawer" aria-label={title} data-testid="drawer" data-panel={shown} onClick={(e) => pick(e, shown)}>
      <header className="drawerbar">
        <h2>{title}</h2>
        <IconButton ref={close} label={`Close ${title}`} variant="muted" size={32} glyph={16} aria-keyshortcuts="Escape" onClick={() => openPanel(null)}>
          <CloseIcon />
        </IconButton>
      </header>
      <div className="drawerbody rnow">
        <Body current={openedChat()} />
      </div>
    </aside>
  );
}
