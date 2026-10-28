import { lazy } from "react";
import { DEV } from "../../shared/base.ts";
import { SHORTCUTS as DEV_SHORTCUTS, ShortcutsHost as DevShortcutsHost, useRailShortcuts as useDevRailShortcuts } from "./DevShortcuts.tsx";
import { SHORTCUTS as MAIN_SHORTCUTS, ShortcutsHost as MainShortcutsHost, useRailShortcuts as useMainRailShortcuts } from "./Shortcuts.tsx";
// Rail: the conversation list with stars, drag order, Older, Cmd+K and ?.
// It draws inside the shell as the desktop sidebar (App.tsx mounts it from width 900px) and as groups of the phone Chats list; it has no URL.
export { groups, isOlder, previewOf, titleOf, rowLabel, FOREVER } from "./model.ts";
export { moveRow, setMute, setStale, setStar, stepRow } from "./actions.ts";
export { startDrag, type Drop } from "./drag.ts";
/** The dev build (/dev) opens the Now drawer on Cmd+.; the main app keeps the rail mode. */
export const SHORTCUTS = DEV ? DEV_SHORTCUTS : MAIN_SHORTCUTS;
export const ShortcutsHost = DEV ? DevShortcutsHost : MainShortcutsHost;
export const useRailShortcuts = DEV ? useDevRailShortcuts : useMainRailShortcuts;
export { ChevronIcon, StarIcon, GripIcon, PinGlyph } from "./icons.tsx";

/** The desktop sidebar is its own chunk: a phone never loads it. */
export const Sidebar = DEV ? lazy(() => import("./DevSidebar.tsx")) : lazy(() => import("./Sidebar.tsx"));
