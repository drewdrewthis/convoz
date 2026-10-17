// The trace mark of design §12.2: `tfus`, time to first useful screen. The first screen that holds what the person came for (Now, or
// the conversation list) sets it once; a trace or a test reads performance.getEntriesByName("tfus").
let marked = false;

/** markUseful sets the `tfus` mark the first time it is called in a page load. */
export function markUseful(): void {
  if (marked) return;
  marked = true;
  performance.mark("tfus");
}
