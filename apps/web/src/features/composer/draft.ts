// The unsent text of the message box, kept per page URL for this tab: a new build takes over and reloads the page by itself
// (sw/index.ts), and the owner's half-written message must be in the box again after it.
const PREFIX = "convoz.draft:";

/** draftKey is where the draft of the page at `path` (a pathname) is kept. */
const draftKey = (path: string) => PREFIX + path;

/** loadDraft is the text last typed on the page at `path` and not sent; "" when there is none or the store cannot be read. */
export function loadDraft(path: string): string {
  try {
    return sessionStorage.getItem(draftKey(path)) ?? "";
  } catch {
    return "";
  }
}

/** saveDraft keeps `text` as the draft of the page at `path`; an empty text removes it. A store that cannot be written keeps nothing. */
export function saveDraft(path: string, text: string): void {
  try {
    if (text === "") sessionStorage.removeItem(draftKey(path));
    else sessionStorage.setItem(draftKey(path), text);
  } catch {
    // private mode or a full store: the draft lives only in the box, as before
  }
}
