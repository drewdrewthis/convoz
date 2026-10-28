import { useSyncExternalStore } from "react";
import { usePath } from "../../shared/navigate.ts";

/**
 * The panels the right drawer can show. To add one (details, Work), add its id here and its entry in registry.tsx: the type checker
 * then refuses a build where one has no entry.
 */
export type PanelId = "now";

const IDS: readonly PanelId[] = ["now"];
let listeners: (() => void)[] = [];
const emit = () => listeners.forEach((f) => f());
addEventListener("popstate", emit);

/** panelOf reads the open panel from a query string ("?panel=now"); an id this build does not know is no panel. */
export function panelOf(search: string): PanelId | null {
  const id = new URLSearchParams(search).get("panel");
  return IDS.find((p) => p === id) ?? null;
}

/** withPanel is a browser URL (path, query and hash) with the panel set, or taken off with null. The rest of the query stays. */
export function withPanel(url: string, panel: PanelId | null): string {
  const u = new URL(url, location.href);
  const rest = [...u.searchParams].filter(([k]) => k !== "panel");
  const query = new URLSearchParams(panel ? [...rest, ["panel", panel]] : rest).toString();
  return u.pathname + (query ? `?${query}` : "") + u.hash;
}

/** openPanel puts the panel in the address (a history entry, so Back closes it) and shows it. */
export function openPanel(panel: PanelId | null): void {
  const to = withPanel(location.href, panel);
  if (to === location.pathname + location.search + location.hash) return;
  history.pushState(null, "", to);
  emit();
}

/** togglePanel closes the panel when it is the one open, and opens it otherwise. */
export const togglePanel = (panel: PanelId): void => openPanel(panelOf(location.search) === panel ? null : panel);

/** usePanel is the panel of the address now. It follows the address when the app navigates (usePath) and on Back and Forward. */
export function usePanel(): PanelId | null {
  usePath();
  return panelOf(
    useSyncExternalStore(
      (notify) => {
        listeners = [...listeners, notify];
        return () => {
          listeners = listeners.filter((f) => f !== notify);
        };
      },
      () => location.search,
    ),
  );
}
