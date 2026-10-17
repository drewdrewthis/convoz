// Search: the search overlay over messages, asks, conversation titles and agents.
// Owned by the search work package. It draws inside the shell, not at a URL of its own: the shell mounts the button and the
// overlay, a result opens a page of its own.
export { SearchButton, SearchHost, useSearchShortcut } from "./Host.tsx";
export { rememberChat } from "./recent.ts";
export { useSearchUi } from "./store.ts";
