import { lazy } from "react";
// Rail: the conversation list with stars, drag order, Older, Cmd+K and ?.
// It draws inside the shell as the desktop sidebar (App.tsx mounts it from width 900px) and as groups of the phone Chats list; it has no URL.
export { groups, isOlder, previewOf, titleOf, rowLabel, FOREVER } from "./model.ts";
export { moveRow, setMute, setStale, setStar, stepRow } from "./actions.ts";
export { startDrag, type Drop } from "./drag.ts";
/** Cmd+. opens the Now drawer. */
export { SHORTCUTS, ShortcutsHost, useRailShortcuts } from "./DevShortcuts.tsx";
export { ChevronIcon, StarIcon, GripIcon, PinGlyph } from "./icons.tsx";

/** The desktop sidebar is its own chunk: a phone never loads it. */
export const Sidebar = lazy(() => import("./DevSidebar.tsx"));
