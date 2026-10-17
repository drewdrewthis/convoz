// The trace mark of design §12.2: `tfus`, time to first useful screen. The first screen that holds what the person came for (Now, or
// the conversation list) sets it once; a trace or a test reads performance.getEntriesByName("tfus"). Work that the first screen does
// not need waits for it (afterFirstScreen), so it does not compete with the screen for a slow phone's CPU.
let marked = false;
let shown!: () => void;
const firstScreen = new Promise<void>((resolve) => (shown = resolve));

/** markUseful sets the `tfus` mark the first time it is called in a page load. */
export function markUseful(): void {
  if (marked) return;
  marked = true;
  performance.mark("tfus");
  shown();
}

/** noFirstScreen says this page sets no mark (only Now and the conversation list do), so nothing waits for one. */
export function noFirstScreen(): void {
  shown();
}

/** A first screen that never comes (an error, a refusal) holds nothing back longer than this. */
const LATEST_MS = 2000;

/** afterFirstScreen resolves once the first screen is useful, or the page has none, and at the latest after 2 s. */
export function afterFirstScreen(): Promise<void> {
  return Promise.race([firstScreen, new Promise<void>((resolve) => setTimeout(resolve, LATEST_MS))]);
}
