import { lazy } from "react";
// Rail: the conversation list with stars, drag order, Older, Cmd+K and ?.
// It draws inside the shell as the desktop sidebar (App.tsx mounts it from width 900px) and as groups of the phone Chats list; it has no URL.
export { groups, previewOf, titleOf, rowLabel, FOREVER } from "./model.ts";
export { moveRow, setMute, setStar, stepRow } from "./actions.ts";
export { SHORTCUTS, ShortcutsHost, useRailShortcuts } from "./Shortcuts.tsx";
export { ChevronIcon, StarIcon, GripIcon, PinGlyph } from "./icons.tsx";

/** The desktop sidebar is its own chunk: a phone never loads it. */
export const Sidebar = lazy(() => import("./Sidebar.tsx"));
